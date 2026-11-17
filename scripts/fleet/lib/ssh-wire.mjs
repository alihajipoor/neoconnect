// What lib/ssh-hub.mjs and lib/ssh-call.mjs share: how an ssh argument
// list is read, and the frames between the two.
//
// A frame is one type byte, a 4-byte big-endian length, then the bytes.
//   caller -> helper   N the caller's random nonce (the first frame)
//                      H header (JSON: mac, body), only after a good A
//                      I standard input bytes, E end of standard input
//   helper -> caller   A the helper's nonce and its proof (the first frame)
//                      P the command may have been sent to the host: from
//                        here on the caller never runs it again itself
//                      R the command runs (standard input may follow)
//                      O standard output, X standard error
//                      S exit status (decimal), the last frame
//                      F "run plain ssh instead" (reason), the last frame;
//                        sent only when the command certainly never ran
//
// Both ends prove they hold the run's token without sending it: a port
// on loopback can be taken by any local account once the helper is gone,
// and whoever holds it must learn neither the token nor a command line.

import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

export const NONCE_BYTES = 32;
// What each side signs. Different labels, so one side's proof can never
// be replayed as the other's.
export const helperProof = (token, callerNonce) => createHmac("sha256", token).update("fleet-hub\0").update(callerNonce).digest();
export const callerMac = (token, helperNonce, body) => createHmac("sha256", token).update("fleet-call\0").update(helperNonce).update("\0").update(body).digest();

export function frame(type, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8");
  const head = Buffer.alloc(5);
  head[0] = type.charCodeAt(0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

export class Framer {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.onFrame = () => {};
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // A frame handler may stop the reading (a refused caller): nothing
    // after that is taken.
    while (this.buf.length >= 5 && !this.stopped) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const type = String.fromCharCode(this.buf[0]);
      const data = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      this.onFrame(type, data);
    }
  }
}

// The options lib/remote.sh gives ssh, and nothing else: anything more is
// left to ssh itself, so nothing is half understood.
export function parseSshArgs(argv, { needCommand = true } = {}) {
  const out = { ok: true, noStdin: false, identities: [], optArgs: [], dest: "", host: "", user: "", command: "" };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-n") {
      out.noStdin = true;
      continue;
    }
    // -F (a configuration file of the caller's choosing) goes to `ssh -G`
    // with the rest, so what the helper reads is what ssh would read.
    if (a === "-i" || a === "-o" || a === "-p" || a === "-l" || a === "-F") {
      const v = argv[i + 1];
      if (v === undefined) return { ok: false, why: `${a} without a value` };
      out.optArgs.push(a, v);
      if (a === "-i") out.identities.push(v);
      i++;
      continue;
    }
    if (a.startsWith("-")) return { ok: false, why: `option ${a} is left to ssh` };
    break;
  }
  out.dest = argv[i] || "";
  if (!out.dest) return { ok: false, why: "no destination" };
  // ssh joins the words after the destination with spaces.
  out.command = argv.slice(i + 1).join(" ");
  if (needCommand && !out.command) return { ok: false, why: "no command (an interactive login is left to ssh)" };
  const at = out.dest.lastIndexOf("@");
  out.user = at >= 0 ? out.dest.slice(0, at) : "";
  out.host = at >= 0 ? out.dest.slice(at + 1) : out.dest;
  return out;
}

// A path as Git Bash writes it (/c/Users/...), as this Windows process
// can open it. Elsewhere a path is already native.
export function msysToNative(p) {
  if (process.platform !== "win32" || !p.startsWith("/")) return p;
  const m = /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:/${m[3]}`;
  try {
    return execFileSync("cygpath", ["-w", p], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    return p;
  }
}
