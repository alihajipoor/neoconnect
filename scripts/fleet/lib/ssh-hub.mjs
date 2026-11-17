// ssh-hub.mjs <port file> <connections file>
//
// One SSH connection per host for the length of a `fleet` run, so that a
// remote call costs a round trip instead of a handshake. On the 2026-11-16
// add, about 480 separate connections at 2.2-4 s each were 62% of its 30
// minutes; OpenSSH's own connection sharing (ControlMaster) does not work
// under this PC's Git Bash, and Windows' ssh.exe has none.
//
// lib/remote.sh starts it (transport_start) and talks to it only through
// lib/ssh-call.mjs, which takes the very argument list `ssh` would have
// been given. Each call is its own channel on the shared connection, so
// standard output, standard error and the exit status stay separate and
// exact, and several calls can run at once.
//
// What it never does on its own judgement is decide that a host is who
// it claims to be. It accepts a host key only when it is byte for byte a
// key the same known_hosts files hold for that host (looked up with
// ssh-keygen -F, as ssh itself would read them). Anything else -- a host
// never seen, a changed key, a revoked one, an ssh_config this cannot
// follow, an authentication it cannot do -- is answered "fall back", and
// the caller runs the plain `ssh` it would have run anyway. So a first
// contact is still taken on by ssh (accept-new), and a changed key is
// still refused by ssh, with ssh's own message.
//
// Only the run that started it may use it: it listens on loopback only,
// and both ends prove they hold the run's random token (lib/ssh-wire.mjs)
// before a command line is sent; the token reaches the callers through
// their environment (never a command line or a file) and never crosses
// the socket. It ends when its standard input closes (the run closes it,
// and so does the run's death), or when the run's process is gone.
// Connections idle for FLEET_HUB_IDLE_S are closed, and opened again
// when needed.
//
// A command is never sent twice. Before a call goes out on a connection
// that has been quiet, a keepalive that runs nothing checks it is alive;
// only that check may lead to a new connection. Once the command may
// have been sent (the P frame), whatever happens is reported the way ssh
// reports a lost connection (exit 255), never tried again.
//
// The private keys are read here and handed to the SSH library; nothing
// of them is written or logged. The log (standard error) names no host.

import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { parseSshArgs, msysToNative, Framer, frame, NONCE_BYTES, helperProof, callerMac } from "./ssh-wire.mjs";

const require = createRequire(import.meta.url);
const { Client, utils } = require("ssh2");

const [portFile, connsFile] = process.argv.slice(2);
const TOKEN = Buffer.from(process.env.FLEET_HUB_TOKEN || "", "utf8");
delete process.env.FLEET_HUB_TOKEN;
if (TOKEN.length < 32 || !portFile) {
  console.error("ssh-hub: no token or no port file");
  process.exit(2);
}
const SSH_BIN = process.env.FLEET_SSH_BIN || "ssh";
const KEYGEN_BIN = /[\\/]/.test(SSH_BIN) ? join(dirname(SSH_BIN), basename(SSH_BIN).replace(/^ssh/, "ssh-keygen")) : "ssh-keygen";
// A connection the host has sent nothing on for this long may have died
// without a word (a rebooted box, a dropped route). Before a command goes
// out on it, a keepalive request (it runs nothing) must be answered
// within PING_TIMEOUT_MS; if not, the call goes on a new connection and
// the old one is left to the calls still on it (ssh's own keepalives end
// it if it is dead). Nothing has been sent at that point, so this cannot
// run a command twice.
const PING_IDLE_MS = Number(process.env.FLEET_HUB_PING_IDLE_MS || 3000);
const PING_TIMEOUT_MS = Number(process.env.FLEET_HUB_PING_TIMEOUT_MS || 5000);
const IDLE_MS = Number(process.env.FLEET_HUB_IDLE_S || 600) * 1000;

const log = (msg) => process.stderr.write(`${new Date().toISOString()} ssh-hub: ${msg}\n`);
const countConnection = (step) => {
  if (!connsFile) return;
  try {
    appendFileSync(connsFile, `${step || "run"}\n`);
  } catch {}
};

// ---------------------------------------------------------------- config

const run = (bin, args) =>
  new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

// What ssh itself would do with these options: `ssh -G` prints the
// effective configuration, ssh_config files included.
const configCache = new Map();
async function resolveConfig(parsed) {
  const key = JSON.stringify([parsed.optArgs, parsed.dest]);
  if (configCache.has(key)) return configCache.get(key);
  const r = await run(SSH_BIN, ["-G", ...parsed.optArgs, parsed.dest]);
  if (r.code !== 0) return { fallback: "ssh -G refused these options" };
  const cfg = new Map();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase();
    cfg.set(k, cfg.has(k) ? `${cfg.get(k)}\n${m[2]}` : m[2]);
  }
  const res = { cfg };
  const val = (k) => (cfg.get(k) || "").trim().toLowerCase();
  // Anything that makes ssh do more than "connect, check the key, log in
  // with -i, run one command" is left to ssh.
  const off = (k) => !cfg.has(k) || ["none", "no", "false", ""].includes(val(k));
  for (const k of ["proxycommand", "proxyjump", "hostkeyalias", "remotecommand", "setenv", "sendenv", "localforward", "remoteforward", "dynamicforward"]) {
    if (!off(k)) res.fallback = `ssh_config sets ${k}`;
  }
  if (val("checkhostip") === "yes") res.fallback = "ssh_config sets checkhostip";
  if (["yes", "force"].includes(val("requesttty"))) res.fallback = "ssh_config asks for a terminal";
  if (val("forwardagent") === "yes" || val("forwardx11") === "yes") res.fallback = "ssh_config forwards an agent or X11";
  if (val("permitlocalcommand") === "yes") res.fallback = "ssh_config runs a local command";
  if (val("tunnel") && val("tunnel") !== "false" && val("tunnel") !== "no") res.fallback = "ssh_config asks for a tunnel device";
  res.host = (cfg.get("hostname") || parsed.host).trim();
  res.port = Number(cfg.get("port") || 22);
  res.user = (cfg.get("user") || parsed.user || "").trim();
  const num = (k, d) => (/^\d+$/.test(val(k)) ? Number(val(k)) : d);
  res.connectTimeoutS = num("connecttimeout", 0);
  res.aliveIntervalS = num("serveraliveinterval", 0);
  res.aliveCountMax = num("serveralivecountmax", 3);
  res.tcpKeepAlive = val("tcpkeepalive") !== "no";
  res.knownHostsFiles = [cfg.get("userknownhostsfile"), cfg.get("globalknownhostsfile")]
    .filter(Boolean)
    .flatMap((v) => v.split(/\s+/))
    .filter((f) => f && f !== "none");
  configCache.set(key, res);
  return res;
}

// The keys the known_hosts files hold for this host, exactly as ssh would
// find them (hashed names, [host]:port, markers): ssh-keygen -F does the
// matching, this only reads the key out of each line it prints.
async function knownKeys(host, port, files) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  const good = [];
  const revoked = [];
  for (const f of files) {
    const r = await run(KEYGEN_BIN, ["-F", name, "-f", f]);
    if (r.code !== 0) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const parts = line.trim().split(/\s+/);
      let marker = "";
      if (parts[0].startsWith("@")) marker = parts.shift();
      const [, type, b64] = parts;
      if (!type || !b64) continue;
      const blob = Buffer.from(b64, "base64");
      if (marker === "@revoked") revoked.push(blob);
      else if (!marker) good.push({ type, blob });
      // @cert-authority lines: host certificates are not used here, so
      // such a host is left to ssh (it finds no plain key below).
    }
  }
  return { good, revoked };
}

const HOSTKEY_ALGS = {
  "ssh-ed25519": ["ssh-ed25519"],
  "ecdsa-sha2-nistp256": ["ecdsa-sha2-nistp256"],
  "ecdsa-sha2-nistp384": ["ecdsa-sha2-nistp384"],
  "ecdsa-sha2-nistp521": ["ecdsa-sha2-nistp521"],
  "ssh-rsa": ["rsa-sha2-512", "rsa-sha2-256"],
};

// ---------------------------------------------------------------- connections

// What ssh prints when a host cannot be reached, so that a step that
// reads "unreachable" from ssh's words reads the same here.
const CONNECT_ERRORS = {
  ECONNREFUSED: "Connection refused",
  ETIMEDOUT: "Connection timed out",
  EHOSTUNREACH: "No route to host",
  ENETUNREACH: "Network is unreachable",
};

class Unreachable extends Error {}
class Fallback extends Error {}

const conns = new Map(); // key -> Promise<Conn>
let connSeq = 0;

function tcpConnect(r) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: r.host, port: r.port });
    let timer;
    const fail = (code) => {
      clearTimeout(timer);
      sock.destroy();
      const text = CONNECT_ERRORS[code];
      if (text) reject(new Unreachable(`ssh: connect to host ${r.host} port ${r.port}: ${text}\r\n`));
      else reject(new Fallback(`tcp ${code}`));
    };
    if (r.connectTimeoutS > 0) timer = setTimeout(() => fail("ETIMEDOUT"), r.connectTimeoutS * 1000);
    sock.once("error", (e) => fail(e.code));
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.removeAllListeners("error");
      if (r.tcpKeepAlive) sock.setKeepAlive(true, 30000);
      resolve(sock);
    });
  });
}

async function openConnection(r, parsed, step) {
  const t0 = Date.now();
  const { good, revoked } = await knownKeys(r.host, r.port, r.knownHostsFiles);
  if (good.length === 0) throw new Fallback("no known key for this host (first contact is left to ssh)");
  const algs = [...new Set(good.flatMap((k) => HOSTKEY_ALGS[k.type] || []))];
  if (algs.length === 0) throw new Fallback("known key types this client cannot check");
  const keys = [];
  for (const p of parsed.identities) {
    let text;
    try {
      text = readFileSync(msysToNative(p));
    } catch {
      continue; // ssh too goes on to the next identity
    }
    const k = utils.parseKey(text);
    if (k instanceof Error || (Array.isArray(k) && k.length === 0)) throw new Fallback("a key this client cannot read (a passphrase?)");
    keys.push(text);
  }
  if (keys.length === 0) throw new Fallback("no readable identity file");
  const t1 = Date.now();
  const sock = await tcpConnect(r);
  const t2 = Date.now();
  return await new Promise((resolve, reject) => {
    const c = new Client();
    let mismatch = false;
    let ready = false;
    const id = ++connSeq;
    const conn = { id, client: c, alive: true, calls: new Set(), lastUse: Date.now(), lastSeen: Date.now(), retired: false };
    // Anything the host sends shows the connection is alive.
    sock.on("data", () => {
      conn.lastSeen = Date.now();
    });
    c.on("ready", () => {
      ready = true;
      countConnection(step);
      // Where a new connection's time goes, for the next real run.
      log(`connection ${id} open (step ${step || "-"}): known_hosts ${t1 - t0} ms, TCP ${t2 - t1} ms, SSH ${Date.now() - t2} ms`);
      resolve(conn);
    });
    c.on("error", (e) => {
      if (!ready) {
        sock.destroy();
        // A host that takes the connection and then says nothing is not
        // asked again by plain ssh: that would double the wait (and the
        // attempts in its auth log). ssh's words and status instead.
        if (e.level === "client-timeout") reject(new Unreachable(`Connection timed out during banner exchange\r\nConnection to ${r.host} port ${r.port} timed out\r\n`));
        else reject(new Fallback(mismatch ? "host key does not match known_hosts" : `handshake: ${e.level || ""} ${e.message}`));
        return;
      }
      conn.lastError = e.level === "client-timeout" ? "timeout" : "error";
    });
    c.on("close", () => {
      conn.alive = false;
      log(`connection ${id} closed${conn.lastError ? ` (${conn.lastError})` : ""}`);
      for (const call of conn.calls) call.connectionLost(conn.lastError === "timeout" ? `Timeout, server ${parsed.host} not responding.\r\n` : `Connection to ${parsed.host} closed by remote host.\r\n`);
      if (!ready) reject(new Fallback("closed during the handshake"));
    });
    let keyIndex = 0;
    c.connect({
      sock,
      username: r.user,
      // ssh's ConnectTimeout covers the connect, and again the banner.
      // Here it covers the banner, key exchange and login together (about
      // 4 s even to the slowest host), so ssh is not outwaited.
      readyTimeout: r.connectTimeoutS > 0 ? r.connectTimeoutS * 1000 : 30000,
      keepaliveInterval: r.aliveIntervalS * 1000,
      keepaliveCountMax: r.aliveCountMax,
      algorithms: { serverHostKey: algs },
      hostVerifier: (blob) => {
        if (revoked.some((k) => k.equals(blob))) {
          mismatch = true;
          return false;
        }
        if (good.some((k) => k.blob.equals(blob))) return true;
        mismatch = true;
        return false;
      },
      // Public key only, the -i files only, in their order: what
      // BatchMode with PasswordAuthentication=no leaves ssh to try first.
      authHandler: (methodsLeft, partial, cb) => {
        if (keyIndex >= keys.length) return cb(false);
        if (methodsLeft && !methodsLeft.includes("publickey")) return cb(false);
        cb({ type: "publickey", username: r.user, key: keys[keyIndex++] });
      },
    });
  });
}

function connKey(r, parsed) {
  return JSON.stringify([r.user, r.host, r.port, parsed.identities]);
}

// A connection no longer handed out: it ends once the calls still on it
// are over (at once if there are none). They are never cut for it.
function retire(conn, why) {
  if (conn.retired) return;
  conn.retired = true;
  log(`connection ${conn.id} retired (${why}), ${conn.calls.size} call(s) still on it`);
  if (conn.calls.size === 0) conn.client.end();
}

// OpenSSH's keepalive global request, with a reply wanted: the one ssh sends
// for ServerAliveInterval: it runs nothing on the host. Answered (success
// or failure alike) means alive. ssh2 has no public call for it; this is
// what its own keepalive does (lib/client.js, ssh2 1.17.0, the version
// package.json pins and transport_start checks).
function ping(conn, ms) {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(ok);
    };
    const t = setTimeout(() => end(false), ms);
    try {
      // Called with (false, data) or (true) for a reply, with an Error
      // when the connection closed first.
      conn.client._callbacks.push((had) => end(!(had instanceof Error)));
      conn.client._protocol.ping();
    } catch {
      end(false);
    }
  });
}

// The host's one connection, opened when there is none or when the one
// there is `dead`. Only that very connection is replaced: one that another
// call has opened meanwhile is used, not ended. Calls that arrive while
// one is being opened wait for the same one.
async function getConnection(r, parsed, step, dead) {
  const key = connKey(r, parsed);
  const p = conns.get(key);
  if (p) {
    const c = await p.catch(() => null);
    if (c && c.alive && !c.retired && c !== dead) return c;
    if (conns.get(key) === p) conns.delete(key);
    else if (conns.has(key)) return getConnection(r, parsed, step, dead);
  }
  const np = openConnection(r, parsed, step);
  conns.set(key, np);
  np.then(
    (c) => c.client.on("close", () => conns.get(key) === np && conns.delete(key)),
    () => conns.get(key) === np && conns.delete(key),
  );
  return np;
}

// A live connection for this call: a quiet one is checked first.
async function liveConnection(r, parsed, step) {
  let conn = await getConnection(r, parsed, step, null);
  if (Date.now() - conn.lastSeen < PING_IDLE_MS) return conn;
  if (await ping(conn, PING_TIMEOUT_MS)) return conn;
  retire(conn, `no answer to a keepalive in ${PING_TIMEOUT_MS} ms`);
  // A new connection has just answered its handshake: no check needed.
  conn = await getConnection(r, parsed, step, conn);
  return conn;
}

// The command on its own channel. Its callback comes only once the host
// has answered the exec request, which it may already be running: no
// timer here, a dead connection is found by the keepalives as ssh finds
// it. `certain` marks the one failure where it surely never ran: the
// host refused to open the channel at all (too many sessions, say).
function execOn(conn, command) {
  return new Promise((resolve, reject) => {
    try {
      conn.client.exec(command, {}, (err, stream) => {
        if (err) return reject(Object.assign(new Error(err.message), { certain: err.reason !== undefined }));
        // Here, not after the promise: the host's answer, the output and
        // the exit status can come in one read, and ssh2 emits "exit"
        // while it reads. Output waits in the stream; "exit" would not.
        stream.fleetExit = null;
        stream.on("exit", (code) => {
          if (typeof code === "number") stream.fleetExit = code;
        });
        resolve(stream);
      });
    } catch (e) {
      // "Not connected": thrown before anything was written.
      reject(Object.assign(new Error(e.message), { certain: true }));
    }
  });
}

// ---------------------------------------------------------------- calls

let lastActivity = Date.now();
let active = 0;

async function handleCall(sock, header, framer) {
  const t0 = Date.now();
  const send = (t, data) => {
    if (!sock.destroyed) return sock.write(frame(t, data));
    return true;
  };
  const parsed = parseSshArgs(header.argv || [], { needCommand: header.op !== "drop" });
  if (!parsed.ok) return send("F", parsed.why), sock.end();
  const r = await resolveConfig(parsed);
  if (r.fallback) {
    log(`fallback: ${r.fallback}`);
    send("F", r.fallback);
    return sock.end();
  }
  if (header.op === "drop") {
    const key = connKey(r, parsed);
    const p = conns.get(key);
    conns.delete(key);
    if (p) {
      const c = await p.catch(() => null);
      if (c) {
        log(`connection ${c.id} dropped on request`);
        c.client.end();
      }
    }
    send("S", "0");
    return sock.end();
  }

  let conn;
  try {
    conn = await liveConnection(r, parsed, header.step);
  } catch (e) {
    // Nothing was sent to the host: plain ssh may make this call.
    if (e instanceof Unreachable) {
      send("X", e.message);
      send("S", "255");
      return sock.end();
    }
    log(`fallback: ${e.message}`);
    send("F", e.message);
    return sock.end();
  }
  if (sock.destroyed) return; // the caller is gone: nothing is sent
  conn.lastUse = Date.now();
  let finished = false;
  const unhook = () => {
    conn.calls.delete(call);
    if (conn.retired && conn.calls.size === 0) conn.client.end();
  };
  const call = {
    connectionLost(msg) {
      if (finished) return;
      finished = true;
      unhook();
      send("X", msg);
      send("S", "255");
      sock.end();
    },
  };
  conn.calls.add(call);
  // P before the exec, and the exec only once P is with the system: if
  // this helper dies from here on, the caller knows the command may have
  // run and does not run it again with plain ssh.
  sock.pSent = true;
  await new Promise((resolve) => (sock.destroyed ? resolve() : sock.write(frame("P", ""), () => resolve())));
  if (sock.destroyed) {
    finished = true;
    unhook();
    return;
  }
  let stream;
  try {
    stream = await execOn(conn, parsed.command);
  } catch (e) {
    if (finished) return; // the connection's loss has been reported
    finished = true;
    unhook();
    if (e.certain) {
      log(`fallback: ${e.message}`);
      send("F", e.message);
      return sock.end();
    }
    // It may have run: reported as ssh reports a lost connection.
    log(`call on connection ${conn.id} lost before its answer: ${e.message}`);
    send("X", `Connection to ${parsed.host} closed by remote host.\r\n`);
    send("S", "255");
    return sock.end();
  }
  if (finished) {
    stream.close();
    return;
  }
  const tOpen = Date.now();
  const finish = () => {
    if (finished) return;
    finished = true;
    unhook();
    // A remote command killed by a signal has no exit status; ssh then
    // exits 255.
    const status = stream.fleetExit !== null && stream.fleetExit !== undefined ? stream.fleetExit : 255;
    // No command in the log: only how long the call waited and took.
    log(`call on connection ${conn.id} (step ${header.step || "-"}): running after ${tOpen - t0} ms, done after ${Date.now() - t0} ms, exit ${status}`);
    send("S", String(status));
    sock.end();
  };
  const pipeOut = (src, t) => {
    src.on("data", (d) => {
      if (!send(t, d)) {
        src.pause();
        sock.once("drain", () => src.resume());
      }
    });
  };
  pipeOut(stream, "O");
  pipeOut(stream.stderr, "X");
  // The status goes last, after the whole of standard error: the channel
  // closes once standard output has ended, while standard error may
  // still hold data paused for this socket. ssh2 ends standard error on
  // the close; the timer is only there so that a call can never hang.
  let closed = false;
  let errEnded = false;
  const maybeFinish = () => closed && errEnded && finish();
  stream.stderr.once("end", () => {
    errEnded = true;
    maybeFinish();
  });
  stream.on("close", () => {
    closed = true;
    if (!errEnded) setTimeout(() => ((errEnded = true), maybeFinish()), 5000).unref();
    maybeFinish();
  });

  // ssh -n: nothing to read, the far side gets end of input at once.
  if (parsed.noStdin) stream.end();
  stream.on("error", () => {});
  stream.stderr.on("error", () => {});
  framer.onFrame = (t, data) => {
    // Input still arriving after the command ended goes nowhere, as
    // with ssh.
    if (finished) return;
    if (t === "I") {
      if (!stream.write(data)) {
        sock.pause();
        stream.once("drain", () => sock.resume());
      }
    } else if (t === "E") stream.end();
  };
  // The caller went away (Ctrl-C): the channel goes with it, as the
  // session would with a killed ssh.
  sock.on("close", () => {
    if (!finished) {
      finished = true;
      unhook();
      stream.close();
    }
  });
  send("R", "");
}

const server = net.createServer({ pauseOnConnect: false }, (sock) => {
  const framer = new Framer();
  let authed = false;
  const authTimer = setTimeout(() => sock.destroy(), 5000);
  sock.on("error", () => {});
  sock.on("data", (d) => {
    framer.push(d);
    // Before the token is checked, nobody gets to make it hold much.
    if (!authed && framer.buf.length > 65536) sock.destroy();
  });
  const refuse = () => {
    framer.stopped = true;
    log("refused a caller without the run's token");
    sock.destroy();
  };
  // First the caller's nonce, answered with this helper's proof and its
  // own nonce; then the header, which must carry the caller's proof over
  // that nonce and the header itself.
  const myNonce = randomBytes(NONCE_BYTES);
  let theirNonce = null;
  framer.onFrame = (t, data) => {
    if (authed) return refuse();
    if (theirNonce === null) {
      if (t !== "N" || data.length !== NONCE_BYTES) return refuse();
      theirNonce = Buffer.from(data);
      sock.write(frame("A", Buffer.concat([myNonce, helperProof(TOKEN, theirNonce)])));
      return;
    }
    if (t !== "H") return refuse();
    let wrapped;
    let header;
    try {
      wrapped = JSON.parse(data.toString("utf8"));
      header = JSON.parse(String(wrapped.body));
    } catch {
      return refuse();
    }
    const given = Buffer.from(String(wrapped.mac || ""), "hex");
    const want = callerMac(TOKEN, myNonce, String(wrapped.body));
    if (given.length !== want.length || !timingSafeEqual(given, want)) return refuse();
    clearTimeout(authTimer);
    authed = true;
    // The caller sends standard input only after R, which handleCall
    // sends once its own frame handler is in place.
    framer.onFrame = () => {};
    active++;
    lastActivity = Date.now();
    sock.on("close", () => {
      active--;
      lastActivity = Date.now();
    });
    handleCall(sock, header, framer)
      .catch((e) => {
        log(`call failed inside the helper: ${e && e.message}`);
        // Plain ssh only while the command certainly has not gone out.
        try {
          if (sock.pSent) {
            sock.write(frame("X", "fleet: the run's SSH helper failed during this call\r\n"));
            sock.write(frame("S", "255"));
          } else sock.write(frame("F", "helper error"));
        } catch {}
        sock.end();
      });
  };
});

function shutdown(why) {
  log(`stopping: ${why}`);
  for (const p of conns.values()) p.then((c) => c.client.end(), () => {});
  server.close();
  try {
    rmSync(portFile, { force: true });
  } catch {}
  setTimeout(() => process.exit(0), 300).unref();
}

// Ctrl-C reaches every process of the terminal. This one stays, so the
// run's end-of-pass cleanup can still use it; it ends when the run
// closes its standard input.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.stdin.on("end", () => shutdown("the run closed it"));
process.stdin.on("error", () => shutdown("the run's pipe broke"));
process.stdin.resume();
// The run that started it, by its process id: if it is gone and the pipe
// is somehow still open (a stray child holding it), stop all the same.
const RUN_PID = Number(process.env.FLEET_RUN_PID || 0);
setInterval(() => {
  if (RUN_PID) {
    try {
      process.kill(RUN_PID, 0);
    } catch (e) {
      if (e.code === "ESRCH") return shutdown("the run is gone");
    }
  }
  // A connection nobody used for a while (an owner's step waiting) is
  // closed; the next call opens a new one.
  if (active === 0 && Date.now() - lastActivity > IDLE_MS && conns.size) {
    log("idle: connections closed");
    for (const p of conns.values()) p.then((c) => c.client.end(), () => {});
    conns.clear();
  }
}, 5000).unref();

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  const tmp = `${portFile}.tmp`;
  // Its own process id too: the run's last resort if it ever has to be
  // stopped from outside.
  writeFileSync(tmp, `${port}\n${process.pid}\n`);
  renameSync(tmp, portFile);
  log("listening on loopback");
});
