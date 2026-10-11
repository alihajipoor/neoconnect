#!/usr/bin/env node
// Fails if a Dockerfile runs `pnpm install` before the files that install
// reads are in the image.
//
// `pnpm install` reads every patch listed under `pnpm.patchedDependencies`
// in the root package.json before it installs anything -- even in an image
// none of whose packages uses the patched one -- and stops with ENOENT when
// one is missing. The deps stages of the backend, panel and discord-bot
// images copy only the manifests and the lockfile before they install, so
// the first patch (the HTTP plugin's, 2026-10-11) broke all three builds,
// and with them every production deploy from main. Nothing in CI builds
// those images, so without this the first to find out would have been a
// deploy.
//
// What counts as copied: a `COPY` from the build context, earlier in the
// same stage or in a stage it is built `FROM`, whose source is the patch
// itself, a directory holding it, or the whole context (`.`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync("package.json", "utf8"));
const patches = Object.values(root.pnpm?.patchedDependencies ?? {});
if (patches.length === 0) {
  console.log("  no patched dependencies, nothing to check");
  process.exit(0);
}

const dockerfiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((path) => /(^|\/)Dockerfile$/.test(path));

/** A path as `COPY` names it, without a leading `./` or a trailing `/`. */
const plain = (path) => path.replace(/^\.\//, "").replace(/\/+$/, "") || ".";

/** Whether a `COPY` source brings `patch` into the image. */
const brings = (source, patch) => {
  const s = plain(source);
  return s === "." || s === patch || patch.startsWith(`${s}/`);
};

/** The Dockerfile's instructions, one per entry, continuation lines joined
 * and comments dropped. */
function instructions(text) {
  const out = [];
  let pending = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    out.push(pending + line);
    pending = "";
  }
  if (pending !== "") out.push(pending);
  return out;
}

let failed = false;
for (const dockerfile of dockerfiles) {
  // What each named stage has copied from the build context so far.
  const stages = new Map();
  let copied = [];
  let installs = 0;
  const missing = new Set();
  for (const instruction of instructions(readFileSync(dockerfile, "utf8"))) {
    const [keyword, ...rest] = instruction.split(/\s+/);
    switch (keyword.toUpperCase()) {
      case "FROM": {
        const words = rest.filter((word) => !word.startsWith("--"));
        copied = [...(stages.get(words[0]) ?? [])];
        const as = words.findIndex((word) => word.toUpperCase() === "AS");
        if (as !== -1 && words[as + 1]) stages.set(words[as + 1], copied);
        break;
      }
      case "COPY":
      case "ADD": {
        // From another stage, not from the context.
        if (rest.some((word) => word.startsWith("--from="))) break;
        const words = rest.filter((word) => !word.startsWith("--"));
        copied.push(...words.slice(0, -1));
        break;
      }
      case "RUN": {
        if (!/\bpnpm\s+(install|i)\b/.test(instruction)) break;
        installs += 1;
        for (const patch of patches) {
          if (!copied.some((source) => brings(source, patch))) missing.add(patch);
        }
        break;
      }
      default:
        break;
    }
  }
  if (installs === 0) {
    console.log(`  ${dockerfile}: runs no pnpm install`);
  } else if (missing.size > 0) {
    failed = true;
    console.log(`  ${dockerfile}: runs pnpm install before copying ${[...missing].join(", ")}`);
  } else {
    console.log(`  ${dockerfile}: clean`);
  }
}

if (failed) {
  console.log();
  console.log("pnpm reads every patched dependency's patch at the start of an install.");
  console.log("Copy the patches in before it, beside the lockfile:  COPY patches ./patches");
  process.exit(1);
}
