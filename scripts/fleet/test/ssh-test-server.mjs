// A loopback SSH server for transport.test.mjs, built on the same library
// as lib/ssh-hub.mjs. It runs each command it is sent with this machine's
// bash, so a "remote" command really reads its input, writes both streams
// and exits with its own status. It speaks real SSH: plain OpenSSH can
// talk to it too, which is how the fallback path is tested.
//
// Three commands are its own, to break a connection on purpose:
//   __DROP__         closes the TCP connection, no exit status sent (an
//                    sshd killed under it, as on a reboot)
//   __SIGNAL__       the command "dies of a signal": no exit status
//   __FREEZE__       the connection goes silent (a box gone without a word)
//   __FREEZE_NEXT__  answers "frozen" with status 0, then goes silent
//   __SLOWREPLY__ <ms> <file>
//                    runs at once (a line "ran" appended to <file>), and
//                    only <ms> later answers the exec request: a command
//                    the host is running before the client has heard
//                    that it started

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Server, utils } = require("ssh2");

export function startServer({ hostKey, clientPublic, bash = process.env.FLEET_BASH || "bash", port = 0 }) {
  const allowed = utils.parseKey(clientPublic);
  const stats = { connections: 0, open: 0, execs: 0, commands: [] };
  const conns = new Set();
  const freeze = (client) => {
    const s = client._sock;
    s.pause();
    s.removeAllListeners("data");
    s.write = () => true;
  };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    stats.connections++;
    stats.open++;
    conns.add(client);
    client.on("close", () => {
      stats.open--;
      conns.delete(client);
    });
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey" || ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (ctx.signature && !allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const slow = /^__SLOWREPLY__ (\d+) (.+)$/.exec(info.command);
          if (slow) {
            stats.execs++;
            stats.commands.push(info.command);
            appendFileSync(slow[2], "ran\n");
            return setTimeout(() => {
              try {
                const s = acceptExec();
                if (!s) return;
                s.write("slow-ok\n");
                s.exit(0);
                s.end();
              } catch {
                // the client closed that channel meanwhile
              }
            }, Number(slow[1]));
          }
          const stream = acceptExec();
          stats.execs++;
          stats.commands.push(info.command);
          if (info.command === "__DROP__") return client._sock.end();
          if (info.command === "__SIGNAL__") {
            stream.exit("KILL", false, "");
            return stream.end();
          }
          if (info.command === "__FREEZE__") return freeze(client);
          if (info.command === "__FREEZE_NEXT__") {
            stream.write("frozen\n");
            stream.exit(0);
            stream.end();
            return setTimeout(() => freeze(client), 50);
          }
          const child = spawn(bash, ["-c", info.command], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
          stream.pipe(child.stdin).on("error", () => {});
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 255);
            stream.end();
          });
        });
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        stats,
        close: () =>
          new Promise((r) => {
            // destroy, not end: a frozen connection would never finish
            // closing, and the test file would never exit.
            for (const c of conns) c._sock.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}
