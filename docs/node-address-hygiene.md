# Never commit a node address or a node hostname

**This repository is public.** Every node IP and every node hostname
committed to it is a permanent, free contribution to fleet enumeration.

## The rule now also covers the replacement domains

Added 2026-09-02. After `neoxify.site` was DNS-poisoned and SNI-blocked
in Iran, replacement domains were registered for the panel, the node
mirrors and the relay. **Those names must never appear in this
repository either**, and the reason is sharper than for the old ones:
the old names are already burned, while the new ones are only useful
for as long as nobody has a list of them.

This repository is public, and the whole mechanism that found the last
set -- a scrape of names -- works just as well on a git grep. Committing
the replacements would hand over the thing that was just bought.

Use `{panel-alt-host}`, `{api-domain-1}`, `{node-domain}` and the like in
docs and the journal, and RFC 2606 names in source and tests. The live
values belong in the panel's database, in the signed endpoint bundle, and
nowhere else.

## The rule

> A production node's public IP address, and the public DNS hostname that
> resolves to it, must never appear in this repository — not in source,
> not in tests, not in comments, not in docs, not in the journal, not in
> a commit message, not in an issue.

Use instead:

| Instead of | Use | Range |
|---|---|---|
| a node's exit address | `203.0.113.10`, `.20`, `.30` … | RFC 5737 TEST-NET-3 |
| a customer's or tester's own address | `192.0.2.228` | RFC 5737 TEST-NET-1 |
| some other third address | `198.51.100.10` | RFC 5737 TEST-NET-2 |
| a node hostname | `fi1.example.net`, `<node hostname>` | RFC 2606 |
| a redacted value in prose or a table | `{finland1}`, `{ir1-host}` | see below |

Two conventions, deliberately different:

- **Source and tests** get real documentation-range addresses, so the
  code still parses, the test still exercises a real IPv4, and a reader
  can still follow the shape of the trace. Keep the substitution
  consistent within a file — if two addresses differed in the original
  and that difference is the point, they must still differ.
- **Docs and the journal** get `{curly-brace}` placeholders naming the
  node — `{finland1}`, `{ir1}`, `{germany-1-host}`. Curly braces, not
  `<angle>` ones: GitHub's markdown sanitiser eats unknown angle-bracket
  tags outside code spans, and most of these sites are running prose or
  table cells.

Whenever you redact, **leave a one-line note saying you did**, pointing
here. A comment explaining a real packet capture loses its meaning if the
numbers silently become noise; it keeps its meaning if the reader knows
they are stand-ins and what they stand for.

**`connect.neoxify.site` is not covered by this rule.** It is the
panel/API, it is Cloudflare-proxied, it is compiled into every shipped
client, and it is meant to be public. The panel *origin* address behind
Cloudflare is a different matter and is redacted, because publishing it
is what lets someone bypass the proxy.

## Why

A measurement pass (`docs/research/gaming-ip-reputation.md`, branch
`claude/gaming-ip-reputation`) established what actually earns an
operator's exit addresses an `is_vpn` label from IP-reputation feeds. It
is not the ASN, not the provider, not the address-space age, and not
whether the product calls itself a VPN or a gaming relay. **It is whether
the fleet is publicly enumerable.**

Two same-provider control pairs carried the finding: on identical
infrastructure, the operator who publishes its node list is flagged and
the operator who does not is clean. Mullvad and NordVPN publish JSON
APIs. Mudfish publishes a status page with a guessable hostname
convention, and 19 of 20 sampled nodes carry an anonymiser flag.
ExitLag, NoPing and Neoxify publish nothing machine-readable, and all
three measure clean.

So "not enumerable" is a real asset, it is free, and it is currently
intact. It is also fragile: it is lost the moment a list exists, and a
public git repository is a list.

## What this does *not* buy

Being honest about the size of it:

1. **Certificate transparency already publishes the node hostnames.**
   Every Let's Encrypt certificate this project issues puts its name in
   a public, permanent, append-only log. `crt.sh` for `%.neoxify.site`
   returns the fleet, and each name resolves to an address. That is the
   same technique this repository's own research used to enumerate
   Mudfish's 635 nodes. **The addresses are therefore already derivable
   without touching this repository at all**, and no amount of git
   hygiene changes that. The remediation for it is
   `docs/node-enumerability-remediation.md`, and it is infrastructure
   work, not a text edit.
2. **Git history is not rewritten.** Every address redacted under this
   rule is still in the repository's history and still visible in the
   GitHub UI on any older commit. Redacting forward reduces the *future*
   scraping surface. It un-publishes nothing.
3. **Some node hostnames are still in shipped source, on purpose.**
   `apps/desktop-windows/src/lib/config.ts` hardcodes two node API
   mirrors as censorship fallbacks. They are compiled into every
   released client, so they are public regardless; removing them from
   the repository would hide nothing and would break the fallback. They
   stay. This rule is about not *adding* to the surface.

The rule is therefore worth following as hygiene and as the thing that
keeps the position once the infrastructure fixes land — not as a
mitigation that stands on its own.

## Where this has already been applied

Redacted in the working tree (history untouched):

- `docs/journal/windows.md`, `docs/journal/HANDOVER-2026-08-22.md` —
  all node addresses, the panel origin address, a beta tester's home
  address, and the node hostnames.
- `docs/design/gaming-mode.md` — the Iran-to-node latency table now
  names nodes without addresses.
- `docs/ikev2-node.md`, `docs/detection-resistance.md`.
- `apps/desktop-windows/service/src/split_tunnel/{owner.rs,redirect.rs}`
  — the Custom-mode DNS-leak capture.
- `apps/desktop-windows/src/lib/{egress,connection-config.test,
  connection-evidence.test,egress.test}.ts`.
- `agent/internal/relay/{provisioner.go,provisioner_converge_test.go}`,
  `agent/internal/protocols/ikev2/parse_test.go`.
- `installer/lib/agent.sh` — a quoted certbot error naming a node.
- `apps/mobile/plugins/vpn/android/.../NeoxifyVpnPlugin.kt` — the
  main-thread DNS failure comment.

**Still carrying node addresses, deliberately left for their owners** so
that three parallel sessions do not collide on the same files:

| File | Owner |
|---|---|
| `apps/backend/src/modules/{agent-gateway,health,protocol-configs,protocol-users,routes}/**` | backend session |
| `apps/desktop-windows/ipc/src/lib.rs`, `service/src/gaming/mod.rs`, `service/src/pipe.rs`, `src-tauri/src/vpn.rs` | Gaming Mode session |
| `apps/desktop-windows/src/lib/config.ts` | see point 3 above — stays |

Same substitution table, same one-line-note convention. Roughly a dozen
sites in total.

**And note:** `docs/research/gaming-ip-reputation.md`, on branch
`claude/gaming-ip-reputation`, tabulates every node address with its
provider and ASN. It is the single densest listing in the project. It
should be redacted before that branch merges to `main`.
