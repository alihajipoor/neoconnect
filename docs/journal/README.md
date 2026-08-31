# The journal — what git cannot record

## What this is not

**Not a changelog.** Git already records what changed and why — the
commit messages here are long on purpose. Duplicating them is wasted
effort that goes stale.

This is a **working log**. It records the things git cannot:

- **What is half-done right now**, and what should not be built on top
  of it yet.
- **Decisions taken but not yet built**, so they are not re-litigated or
  contradicted.
- **What is blocked, and on what** — an account that needs creating, a
  device test that needs running, access that needs restoring.
- **Gotchas that cost real time**, so they are not paid for twice.
- **Environment facts** — toolchain versions, what hardware is attached,
  what can and cannot be built here.

If it is already obvious from `git log` or the code, leave it out.

## The files

| File | Status | Contains |
|---|---|---|
| `log.md` | **current** | The working log. Append here. |
| `shared.md` | current | Standing decisions and constraints that outlive a session |
| `windows.md` | **archive** | Windows-machine log, 2026-05 → 2026-08-27 |
| `macos.md` | **archive** | Mac/iOS log, 2026-08-11 |
| `HANDOVER-2026-08-22.md` | archive | Consolidated state as of 2026-08-22 |

### Why there are archives

Until 2026-08-30 this repo was worked on by two machines that could not
see each other — a Windows box and a MacBook — each writing its own file
so the two could never conflict. The Windows machine is gone and that
protocol is retired. **One log now: `log.md`.**

`windows.md` is 750 KB of incident detail and is **still the reference
for most of this system's behaviour** — it is cited from source
comments (`ipv6_block.rs`, `ipc/src/lib.rs`) and from half of `docs/`.
Do not move, rename or prune it. Read it; append elsewhere.

`shared.md` stays current. It was the cross-machine file, but what it
actually holds is standing constraints — live-user rules, tag
discipline, the signing-account state — which are still true.

## The protocol

**At the start of a session:**

```bash
bash scripts/session-start.sh
```

It pulls and prints the log. Read it. If it says something is in flight,
believe it.

**After landing anything worth knowing about**, append an entry and push
in the same session. An entry written but not pushed helps nobody — and
this repo has already lost a branch that way: `claude/config-refresh-
and-inbound-tag` was finished on the Windows machine, recorded in
`shared.md`, and never pushed. It went with the machine.

**Push early.** With one machine there is no second copy of anything
uncommitted.

## Entry format

Append at the bottom, under a dated heading:

```markdown
## 2026-08-30 — short title

**Status:** done | in flight | blocked on <what>
**Touches:** apps/mobile/src/screens/Dashboard.tsx

What a future session needs to know. Why, not what — the diff covers
what. If something is in flight, say explicitly what is not safe to
build on yet. If something is unproven, say so in those words.
```

Keep entries short. Prune ones that have gone stale rather than letting
the file grow into something nobody reads — a journal people skip is
worse than none, because it looks authoritative while being wrong.
