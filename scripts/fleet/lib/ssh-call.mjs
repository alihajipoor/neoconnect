// ssh-call.mjs <the arguments ssh would get>
// ssh-call.mjs --drop <the arguments ssh would get, without a command>
//
// The thin caller of lib/ssh-hub.mjs: it behaves as `ssh` would with the
// same arguments -- standard input passed on (unless -n), standard output
// and standard error kept apart and byte for byte, ssh's exit status --
// but over the run's one connection to that host.
//
// Whenever the helper is not there, cannot prove it is the run's helper,
// or answers that this call is ssh's to make (a first contact, a changed
// host key, anything it cannot follow), this exits with FALLBACK_RC after
// writing the reason to the file FLEET_CALL_FB names, without having read
// any of its standard input. lib/remote.sh (fssh) then runs the real ssh
// itself, from bash, with the same arguments and the same input: the path
// proven on real servers, with no second layer of argument parsing.
// --drop closes the helper's connection to that host (before a reboot),
// and does nothing without it.
//
// Once the helper has said the command may have been sent (P), the call
// is never handed to plain ssh: a helper that goes away after that is a
// lost connection, exit 255, as ssh reports one.

import { writeFileSync } from "node:fs";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Framer, frame, parseSshArgs, NONCE_BYTES, helperProof, callerMac } from "./ssh-wire.mjs";

export const FALLBACK_RC = 254;

let argv = process.argv.slice(2);
const drop = argv[0] === "--drop";
if (drop) argv = argv.slice(1);

const PORT = Number(process.env.FLEET_HUB_PORT || 0);
const TOKEN = Buffer.from(process.env.FLEET_HUB_TOKEN || "", "utf8");
const FB = process.env.FLEET_CALL_FB || "";
const step = process.env.CURRENT_STEP || "";
// How long the helper has to prove itself before plain ssh is used.
const HELLO_MS = Number(process.env.FLEET_CALL_HELLO_MS || 10000);

// A reader that went away (`| head`) must not turn the exit status into
// a crash of this process.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function exitAfterFlush(code) {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

// Hand the call back to bash, which runs plain ssh. Nothing of standard
// input has been read at this point.
function plainSsh(why) {
  if (drop) return process.exit(0);
  if (process.env.FLEET_HUB_DEBUG) process.stderr.write(`ssh-call: plain ssh (${why})\n`);
  try {
    writeFileSync(FB, `${why}\n`);
  } catch {
    // Without the marker, bash would read the status as the command's.
    process.stderr.write("fleet: the run's SSH helper could not be used, and the call was not made\r\n");
    return process.exit(255);
  }
  process.exit(FALLBACK_RC);
}

if (!PORT || TOKEN.length < 32 || !FB) plainSsh("no helper");
else if (!parseSshArgs(argv, { needCommand: !drop }).ok) plainSsh("arguments");
else {
  const parsed = parseSshArgs(argv, { needCommand: !drop });
  const sock = net.connect({ host: "127.0.0.1", port: PORT });
  const framer = new Framer();
  const myNonce = randomBytes(NONCE_BYTES);
  let proven = false; // the helper showed it holds the token
  let mayHaveRun = false; // P seen: never plain ssh from here
  let done = false;
  const handBack = (why) => {
    if (done) return;
    done = true;
    framer.stopped = true;
    sock.destroy();
    plainSsh(why);
  };
  const hello = setTimeout(() => handBack("the helper did not prove itself in time"), HELLO_MS);
  // Nobody listening: the helper is gone (or never was). Nothing has
  // been sent, so plain ssh runs this call.
  sock.on("error", () => {
    if (!mayHaveRun) handBack("helper unreachable");
  });
  sock.on("connect", () => sock.write(frame("N", myNonce)));
  sock.on("data", (d) => framer.push(d));
  sock.on("close", () => {
    if (done) return;
    if (!mayHaveRun) return handBack("helper closed");
    // Gone after the command may have gone out: it is not run again.
    done = true;
    process.stderr.write("fleet: the run's SSH helper went away during this call\r\n");
    exitAfterFlush(255);
  });
  const out = (stream, d) => {
    if (!stream.write(d)) {
      sock.pause();
      stream.once("drain", () => sock.resume());
    }
  };
  framer.onFrame = (t, data) => {
    if (done) return;
    if (!proven) {
      // The first frame must be the helper's proof over this nonce.
      // Anything else -- another program on this port -- gets nothing:
      // no token, no command line, no input.
      if (t !== "A" || data.length !== NONCE_BYTES + 32) return handBack("not the run's helper");
      const theirNonce = data.subarray(0, NONCE_BYTES);
      const proof = data.subarray(NONCE_BYTES);
      if (!timingSafeEqual(proof, helperProof(TOKEN, myNonce))) return handBack("not the run's helper");
      proven = true;
      clearTimeout(hello);
      const body = JSON.stringify({ argv, step, op: drop ? "drop" : "exec" });
      sock.write(frame("H", JSON.stringify({ mac: callerMac(TOKEN, theirNonce, body).toString("hex"), body })));
      return;
    }
    switch (t) {
      case "P":
        mayHaveRun = true;
        break;
      case "R":
        mayHaveRun = true;
        if (!parsed.noStdin) {
          process.stdin.on("data", (d) => {
            if (!sock.write(frame("I", d))) {
              process.stdin.pause();
              sock.once("drain", () => process.stdin.resume());
            }
          });
          process.stdin.on("end", () => sock.write(frame("E", "")));
          process.stdin.on("error", () => sock.write(frame("E", "")));
        }
        break;
      case "O":
        out(process.stdout, data);
        break;
      case "X":
        out(process.stderr, data);
        break;
      case "S":
        done = true;
        sock.destroy();
        // process.exit, not a natural end: a read pending on a Windows
        // pipe or terminal would otherwise keep this process alive after
        // the command has ended (ssh does not wait for its input either).
        exitAfterFlush(Number(data.toString()) || 0);
        break;
      case "F":
        // The helper says the command never ran (it is sent only then).
        handBack(`helper: ${data.toString()}`);
        break;
      default:
        break;
    }
  };
}
