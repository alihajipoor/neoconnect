#!/usr/bin/env node
/**
 * Cloudflare DNS for `fleet`.
 *
 * The token is read from the file CF_TOKEN_FILE names, whitespace
 * stripped, and sent only as a Bearer header; it is never printed. Every
 * address in every output line is masked (a.b.x.x).
 *
 *   cf.mjs list     <zone>                    all records, content masked
 *   cf.mjs get      <zone> <fqdn>             records with that exact name ("free" when none)
 *   cf.mjs create-a <zone> <fqdn> <ipv4>      DNS-only A record; refuses an existing name
 *   cf.mjs delete   <zone> <recordId>
 *   cf.mjs sweep    <ipv4> <names-out> <zone> [zone...] [--delete]
 *                                             every record in those zones whose content IS the
 *                                             address (compared here, never printed whole); the
 *                                             names go to the file, for the NXDOMAIN check
 *                                             ("-" for no file)
 *   cf.mjs doh      <fqdn> gone|<ipv4>        public resolver check: NXDOMAIN, or exactly that address
 */
import { readFileSync, writeFileSync } from "node:fs";
import { aRecordBody, dohVerdict, isV4, recordLine, recordsPointingAt } from "./dns.mjs";

const usage = () => {
  console.error("usage: cf.mjs list|get|create-a|delete|sweep|doh ... (see the header of this file)");
  process.exit(2);
};

const [cmd, ...a] = process.argv.slice(2);
if (!cmd) usage();

let token = null;
const api = async (path, opts = {}) => {
  if (token === null) {
    const file = process.env.CF_TOKEN_FILE;
    if (!file) throw new Error("CF_TOKEN_FILE is not set (fleet.env)");
    token = readFileSync(file, "utf8").replace(/\s+/g, "");
  }
  const r = await fetch("https://api.cloudflare.com/client/v4" + path, {
    ...opts,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  const j = await r.json();
  if (!j.success) throw new Error("Cloudflare refused: " + JSON.stringify(j.errors));
  return j.result;
};

const zoneId = async (name) => {
  const zones = await api("/zones?name=" + encodeURIComponent(name));
  if (!zones.length) throw new Error("zone not in this account: " + name);
  return zones[0].id;
};

const all = async (zid) => {
  const out = [];
  for (let page = 1; ; page++) {
    const recs = await api(`/zones/${zid}/dns_records?per_page=100&page=${page}`);
    out.push(...recs);
    if (recs.length < 100) return out;
  }
};

const run = {
  async list() {
    if (!a[0]) usage();
    for (const r of await all(await zoneId(a[0]))) console.log(recordLine(r));
  },
  async get() {
    if (!a[1]) usage();
    const recs = await api(`/zones/${await zoneId(a[0])}/dns_records?name=${encodeURIComponent(a[1])}`);
    if (!recs.length) console.log("free");
    for (const r of recs) console.log(recordLine(r));
  },
  async "create-a"() {
    const [zone, name, ip] = a;
    const body = aRecordBody(name ?? "", ip, zone ?? "");
    const zid = await zoneId(zone);
    const exist = await api(`/zones/${zid}/dns_records?name=${encodeURIComponent(name)}`);
    if (exist.length) throw new Error("a record with that name already exists");
    const r = await api(`/zones/${zid}/dns_records`, { method: "POST", body: JSON.stringify(body) });
    console.log("created\t" + recordLine(r));
  },
  async delete() {
    if (!/^[0-9a-f]{32}$/.test(a[1] || "")) usage();
    const r = await api(`/zones/${await zoneId(a[0])}/dns_records/${a[1]}`, { method: "DELETE" });
    console.log("deleted " + r.id);
  },
  async sweep() {
    const del = a.includes("--delete");
    const [ip, namesOut, ...zones] = a.filter((x) => x !== "--delete");
    if (!isV4(ip) || !namesOut || !zones.length) usage();
    const names = [];
    let total = 0;
    for (const zone of zones) {
      const zid = await zoneId(zone);
      const hits = recordsPointingAt(await all(zid), ip);
      console.log(`${zone}: ${hits.length} record(s) point at the address`);
      for (const r of hits) {
        total++;
        names.push(r.name);
        if (del) {
          await api(`/zones/${zid}/dns_records/${r.id}`, { method: "DELETE" });
          console.log("  deleted\t" + recordLine(r));
        } else {
          console.log("  found\t" + recordLine(r));
        }
      }
    }
    if (namesOut !== "-") writeFileSync(namesOut, names.join("\n") + (names.length ? "\n" : ""));
    console.log(`total ${total}${del ? " deleted" : " found"}`);
  },
  async doh() {
    const [name, want] = a;
    if (!name || !want) usage();
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, {
      headers: { accept: "application/dns-json" },
    });
    const verdict = dohVerdict(await r.json(), want === "gone" ? "" : want);
    console.log(verdict);
    const ok = want === "gone" ? verdict === "gone" : verdict === "match";
    process.exit(ok ? 0 : 1);
  },
};

if (!run[cmd]) usage();
try {
  await run[cmd]();
} catch (e) {
  console.error("refused: " + e.message);
  process.exit(1);
}
