# The journal — how two machines stay in sync

Work runs on two machines that cannot see each other: a **Windows** box
(desktop client, backend, panel, installer, Android) and a **MacBook**
(iOS, which cannot be built anywhere else). Each runs its own assistant
session with its own context, and neither inherits the other's.

GitHub is the only thing they share. So anything the other machine needs
to know has to be committed, not remembered.

## What this is not

**Not a changelog.** Git already records what changed and why — the
commit messages here are long on purpose. Duplicating them is wasted
effort that goes stale.

This is a **handoff log**. It records the things git cannot:

- **What is half-done right now**, and therefore what the other machine
  should not touch.
- **Decisions taken but not yet built**, so they are not re-litigated or
  contradicted.
- **What is blocked, and on whom** — an account that needs creating, a
  device test that needs running.
- **Gotchas that cost real time**, so the other machine does not pay
  twice.
- **Environment facts** that differ per machine (toolchain versions,
  what hardware is attached).

If it is already obvious from `git log` or the code, leave it out.

## The files

| File | Written by | Contains |
|---|---|---|
| `shared.md` | either, rarely | Decisions affecting both platforms; current blockers |
| `windows.md` | Windows only | Desktop / backend / panel / Android session state |
| `macos.md` | Mac only | iOS session state |

**A machine writes only its own file.** That is deliberate: two sessions
never edit the same file, so these can never conflict. `shared.md` is
the one exception and is edited rarely and deliberately — append at the
bottom and a conflict stays trivial.

## The protocol

**At the start of a session**, before touching anything:

```bash
bash scripts/session-start.sh
```

That pulls and prints the journal. Read the other machine's file and
`shared.md`. If it says something is in flight, believe it.

**Before changing a shared file** — `apps/mobile/src/**`,
`apps/mobile/plugins/vpn/src/*.rs`, or any mobile version file — check
the other machine's entries first. Those are the only files where the
two workstreams genuinely collide, and the dangerous conflicts there
merge cleanly and break at runtime.

**After landing anything worth knowing about**, append an entry and push
in the same session. An entry written but not pushed helps nobody; the
push *is* the handoff.

## Entry format

Append at the bottom, under a dated heading:

```markdown
## 2026-08-11 — short title

**Status:** done | in flight | blocked on <who/what>
**Touches:** apps/mobile/src/screens/Dashboard.tsx

What the other machine needs to know. Why, not what — the diff covers
what. If something is in flight, say explicitly what not to touch.
```

Keep entries short. Prune ones that have gone stale rather than letting
the file grow into something nobody reads — a journal people skip is
worse than none, because it looks authoritative while being wrong.
