# Setting up a Windows development machine

Written to be handed to a fresh Claude Code session on the new machine,
which starts with no memory of how any of this works.

Nothing here needs a secret. The seed bundle comes from a public URL and
the bundled engines come from their upstream releases, so a clone and a
build are enough to get a working checkout.

## Prerequisites

| | |
|---|---|
| Git | any recent version |
| Node | **20 or newer** |
| pnpm | **9.15.0 exactly** — the repo pins it in `packageManager` |
| Rust | stable, **MSVC** toolchain (`x86_64-pc-windows-msvc`), not GNU |
| Visual Studio Build Tools | "Desktop development with C++" |

The MSVC toolchain and Build Tools are the two that bite. Rust cannot
link on Windows without the MSVC linker, and installing the GNU
toolchain by mistake produces linker errors that look like missing
crates.

## Getting a working checkout

```powershell
git clone https://github.com/alihajipoor/neoconnect.git
cd neoconnect
pnpm install

cd apps\desktop-windows
powershell -ExecutionPolicy Bypass -File src-tauri\scripts\fetch-binaries.ps1
cargo check --workspace --all-targets
```

`fetch-binaries.ps1` downloads WireGuard, Xray and OpenVPN from their
own release pages. It needs network access and nothing else.

That `cargo check` is the point of having a Windows machine at all. This
crate does not compile anywhere else, so every type error in it has
historically cost a full CI round trip of about sixteen minutes to
discover — `rustfmt --check` proves syntax and never types. Locally it
is seconds.

## Running the tests

```powershell
cd apps\desktop-windows
cargo test --workspace     # the service: ~390 tests
pnpm test                  # the client: ~385 tests
```

**Use `pnpm test`, not `npx vitest`.** A `pretest` hook patches
generated files first — the seed bundle and the capability allowlist —
and running vitest directly skips it. The symptom is
`api-endpoints.scope.test.ts` failing with "not covered by any entry in
capabilities/default.json" on a checkout that is perfectly fine.

## Rules this repository enforces

A new session will not know these and all of them have been breached at
least once.

**Never stage these three files.** They are patched at build time with
the real mirror hostnames and the names must not enter git:

- `apps/desktop-windows/src-tauri/capabilities/default.json`
- `apps/mobile/src-tauri/capabilities/default.json`
- `apps/desktop-windows/src-tauri/tauri.conf.json`

They will show as modified constantly. That is correct. `scripts/check-committed-capabilities.sh` exists because this has been
breached twice, both times by staging a working copy a local test run
had already patched. When a version bump genuinely needs to touch
`tauri.conf.json`, stash the working copy, edit the clean file, commit,
then restore.

**Node addresses never enter the repository.** Not in source, tests,
comments, docs, commit messages or issues. See
`docs/node-address-hygiene.md`.

**No Claude attribution in commits or pull requests.** No
`Co-Authored-By`, no "Generated with" line. History was rewritten once
to remove them.

**CI only runs on `main`, `claude/**` and `rig/**`.** A branch named
anything else gets no CI at all, silently.

**Do not run `rustfmt` to format.** It follows `mod` declarations and
will reformat whole subtrees. The house line width is wider than its
default and CI does not enforce formatting. `rustfmt --check` for a
syntax check is fine — count lines beginning `error`.

**Batch pushes to CI.** Windows runners bill at a 2x multiplier and
twenty pushes in one session once exhausted the account's Actions quota
mid-release. Verify locally, push once per meaningful chunk.

## What does not move from the Mac

Xcode, the Apple Developer ID and the iOS signing certificates. iOS and
macOS builds stay there. This is a two-machine setup — Windows for the
client and the service, Mac for the Apple platforms.

## What to copy by hand

**Claude's memory files**, which do not live in git and hold context the
repository deliberately does not: operational facts, account state, and
decisions that are nobody else's business. On the Mac they are at
`~/.claude/projects/-Users-alihajipoor-Desktop-Claude-Neoxify/memory/`
— 29 markdown files, about 128 KB.

Start Claude in the project on the new machine once so it creates its
own folder (the name encodes the project path, so it will differ), then
copy the `.md` files into the `memory/` directory inside it.

Do **not** commit them. Some record infrastructure addresses, and this
repository is public.

**The SSH key for the panel host**, if deploys or log reading are wanted
from this machine.

## Where to read next

- `CLAUDE.md` — the working agreement for this repository
- `docs/architecture.md` — how the pieces fit
- `docs/windows-service-rewrite.md` — the rewrite in progress, its rules
  and what is done
- `docs/split-tunnel-rewrite.md` — the frozen boundary and the 215 tests
  that are the acceptance criteria
- `docs/test-rig.md` — the VM for exercising the client safely
