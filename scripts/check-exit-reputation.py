#!/usr/bin/env python3
"""Fails when a Neoxify exit address starts being labelled a VPN or a proxy.

Why this exists
---------------
`docs/research/gaming-ip-reputation.md` measured every Neoxify exit against
five independent reputation feeds on 2026-08-25 and found the fleet clean:
`is_datacenter: true` everywhere, and `is_vpn` / `is_proxy` / "Anonymizing
VPN" false everywhere.  That is the whole ban-safety proposition for gamers.
ExitLag and NoPing measure identically; Mudfish, Mullvad and NordVPN do not.

The measurement also established that the clean result is **not** a property
of the provider, the ASN, the address-space age or the paperwork.  It tracks
whether the operator's exit list is publicly enumerable, it is behaviour
driven, and the report says so plainly: *"this result has a shelf life."*

So the finding is perishable, and today nothing would notice it perishing.
A customer discovering it is the worst possible detector.  This script is
the detector.

What "checked and clean" is allowed to mean
-------------------------------------------
This project has been burned repeatedly by checks that pass by not running:
a "Connected" indicator that never verified traffic flowed, a CI workflow
that had never completed once, counters and exit codes that produced false
passes.  So the exit status here distinguishes three outcomes and never
collapses them:

    0  every required lookup succeeded, and nothing adverse is unacknowledged
    1  REGRESSION -- a new adverse flag, or a new blocklist membership
    2  INCOMPLETE -- a required lookup failed, so "clean" is not claimable
    3  usage or setup error (no node source, psql missing, ...)

Exit 2 is the important one.  A silent run is only trustworthy if a failed
lookup cannot produce silence.

Adverse flags that are already known and accepted live in
`scripts/exit-reputation-baseline.json`, keyed by node **name** -- never by
address.  Accepting a new one is a deliberate human edit, which is the point:
it forces somebody to look at it once.

Node addresses
--------------
`docs/node-address-hygiene.md`: a production node's address must never enter
this public repository, and reverse-DNS forms hide an address from a plain
grep -- Hetzner reverses the octets (`10.113.0.203.clients...`), Linode and
Vultr dash them (`203-0-113-10...`).  Therefore:

  * the artifact is written under a gitignored directory (default `var/`);
  * everything printed to stdout is redacted by default, in all four forms,
    so a run can be pasted into an issue or a chat without leaking the fleet;
  * `--show-addresses` opts out, for a human reading a terminal.

Why Python and not bash
-----------------------
This has to run where the node list is -- the panel host -- and Ubuntu
ships python3 but not jq.  Standard library only: no pip install, no
lockfile, nothing to rot.  It is deliberately not wired into CI: CI has no
database and no business making 40 third-party requests per push.

Cost
----
Nothing here is paid, nothing requires an account, and no credential is
sent anywhere.  Free tiers and public endpoints only.  getipintel.net is
deliberately *not* queried even though it is the one vendor with a proven
production game integration, because its API requires an email address as a
query parameter and that is the owner's to hand over, not this script's.

No node is contacted.  Every lookup hits a third-party database about an
address; the address itself is never dialled.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = REPO_ROOT / "scripts" / "exit-reputation-baseline.json"
PUBLISHER_BLOCKS_PATH = REPO_ROOT / "scripts" / "publisher-blocks.json"
DEFAULT_ARTIFACT_DIR = REPO_ROOT / "var" / "exit-reputation"

USER_AGENT = "Mozilla/5.0 (compatible; neoxify-exit-reputation-check/1)"

# Required feeds decide whether the run may claim "checked".  Optional feeds
# are recorded and reported, but their failure does not turn a clean run into
# an unknown one -- proxycheck.io's unkeyed tier is 100 lookups a *day* and
# will legitimately run out, and Scamalytics is an HTML scrape that will
# break the first time they touch their markup.  Neither should be able to
# hold the whole check hostage; both are corroboration, not the signal.
REQUIRED_FEEDS = ("ipapi_is", "ip_api_com", "x4bnet", "rdns")
OPTIONAL_FEEDS = ("proxycheck_io", "scamalytics")

X4BNET_VPN_URL = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt"
X4BNET_DC_URL = "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/datacenter/ipv4.txt"
X4BNET_MAX_AGE_S = 24 * 3600

# Certificate transparency is the live threat to the whole property -- see
# docs/node-enumerability-remediation.md.  A name appearing here that was not
# there last time means a certificate was issued outside policy and the fleet
# just got easier to enumerate, permanently: CT logs are append-only.
# Both domains are checked because historical node names exist under each.
DEFAULT_CT_DOMAINS = ("neoxify.site", "neoxify.com")


# --------------------------------------------------------------------------
# redaction
# --------------------------------------------------------------------------

def address_forms(ip: str) -> list[str]:
    """Every textual form of an address that could appear in feed output.

    A plain grep for the address misses two of these entirely, which is
    exactly how a node address survives a redaction pass and reaches a
    commit.  Ordered longest-first so replacement cannot leave a fragment.
    """
    octets = ip.split(".")
    if len(octets) != 4:
        return [ip]
    rev = ".".join(reversed(octets))
    forms = [
        ip,                          # 203.0.113.10
        rev,                         # 10.113.0.203   (in-addr.arpa, Hetzner PTR)
        "-".join(octets),            # 203-0-113-10   (Linode, Vultr, constant.com)
        "-".join(reversed(octets)),  # 10-113-0-203
    ]
    return sorted(set(forms), key=len, reverse=True)


def redact(text: str, nodes: list[dict[str, Any]]) -> str:
    for node in nodes:
        addr = node.get("address")
        if not addr:
            continue
        placeholder = "{%s}" % node.get("name", "node")
        for form in address_forms(addr):
            text = text.replace(form, placeholder)
    return text


# --------------------------------------------------------------------------
# http
# --------------------------------------------------------------------------

class FeedError(Exception):
    pass


def http_get(url: str, timeout: int = 20, retries: int = 2, accept_json: bool = True) -> Any:
    """One GET, with backoff on the failures that are actually transient.

    A 404 or a 400 is a permanent answer and retrying it just burns rate
    limit; a timeout, a 429 or a 5xx is worth one more try.
    """
    last: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw) if accept_json else raw
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in (408, 429, 500, 502, 503, 504):
                raise FeedError(f"HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last = exc
        except json.JSONDecodeError as exc:
            raise FeedError("response was not JSON") from exc
        if attempt < retries:
            time.sleep(2 * (attempt + 1))
    raise FeedError(str(last))


# --------------------------------------------------------------------------
# node source
# --------------------------------------------------------------------------

NODE_QUERY = 'SELECT name, role, region, "publicIp", status FROM nodes ORDER BY name'


def nodes_from_psql(database_url: str) -> list[dict[str, str]]:
    if not shutil.which("psql"):
        raise SystemExit(
            "check-exit-reputation: psql not found on PATH.\n"
            "  Run this on the panel host, or use --nodes-from compose,\n"
            "  or --nodes-file with a TSV/JSON export."
        )
    out = subprocess.run(
        ["psql", database_url, "-At", "-F", "\t", "-c", NODE_QUERY],
        capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        raise SystemExit(f"check-exit-reputation: psql failed: {out.stderr.strip()}")
    return parse_tsv(out.stdout)


def nodes_from_compose(compose_file: str, env_file: str | None) -> list[dict[str, str]]:
    """The idiom infra/scripts/restore.sh already uses to reach the live DB."""
    cmd = ["docker", "compose", "-f", compose_file]
    if env_file:
        cmd += ["--env-file", env_file]
    cmd += ["exec", "-T", "postgres", "psql", "-U", "neoxify", "-d", "neoxify",
            "-At", "-F", "\t", "-c", NODE_QUERY]
    out = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        raise SystemExit(f"check-exit-reputation: docker compose psql failed: {out.stderr.strip()}")
    return parse_tsv(out.stdout)


def parse_tsv(text: str) -> list[dict[str, str]]:
    nodes = []
    for line in text.splitlines():
        line = line.rstrip("\n")
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        nodes.append({
            "name": parts[0], "role": parts[1], "region": parts[2],
            "address": parts[3], "status": parts[4] if len(parts) > 4 else "",
        })
    return nodes


def nodes_from_file(path: Path) -> list[dict[str, str]]:
    text = path.read_text(encoding="utf-8")
    stripped = text.lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        data = json.loads(text)
        rows = data["nodes"] if isinstance(data, dict) else data
        return [{
            "name": r.get("name", "?"), "role": r.get("role", ""),
            "region": r.get("region", ""),
            "address": r.get("address") or r.get("publicIp", ""),
            "status": r.get("status", ""),
        } for r in rows]
    return parse_tsv(text)


# --------------------------------------------------------------------------
# feeds
# --------------------------------------------------------------------------

def feed_ipapi_is(ip: str) -> dict[str, Any]:
    """The only feed here that publishes its classification algorithm."""
    d = http_get(f"https://api.ipapi.is/?q={ip}")
    if not isinstance(d, dict) or "ip" not in d:
        raise FeedError("unexpected payload")
    return {
        "is_datacenter": d.get("is_datacenter"),
        "is_vpn": d.get("is_vpn"),
        "is_proxy": d.get("is_proxy"),
        "is_abuser": d.get("is_abuser"),
        "is_tor": d.get("is_tor"),
        "asn_num": d.get("asn_num") or (d.get("asn") or {}).get("asn"),
        "asn_org": d.get("asn_org") or (d.get("asn") or {}).get("org"),
        "company_name": d.get("company_name") or (d.get("company") or {}).get("name"),
        "country": d.get("cc") or d.get("location", {}).get("country_code"),
    }


def feed_ip_api_com(ip: str) -> dict[str, Any]:
    """`hosting` is the free stand-in for IPinfo's `isp` vs `hosting` ASN type,
    which now needs a token.  `proxy` is its anonymiser flag."""
    d = http_get(
        f"http://ip-api.com/json/{ip}"
        "?fields=status,message,isp,org,as,asname,mobile,proxy,hosting,query,countryCode"
    )
    if not isinstance(d, dict) or d.get("status") != "success":
        raise FeedError(str((d or {}).get("message", "status != success")))
    return {
        "proxy": d.get("proxy"),
        "hosting": d.get("hosting"),
        "mobile": d.get("mobile"),
        "as": d.get("as"),
        "asname": d.get("asname"),
        "isp": d.get("isp"),
        "org": d.get("org"),
        "country": d.get("countryCode"),
        "asn_type": "hosting" if d.get("hosting") else "isp",
    }


def feed_proxycheck_io(ip: str) -> dict[str, Any]:
    d = http_get(f"https://proxycheck.io/v2/{ip}?vpn=1&asn=1&risk=1")
    if not isinstance(d, dict):
        raise FeedError("unexpected payload")
    if d.get("status") not in ("ok", "warning"):
        raise FeedError(str(d.get("message") or d.get("status") or "error"))
    entry = d.get(ip) or {}
    return {"proxy": entry.get("proxy"), "type": entry.get("type"), "risk": entry.get("risk")}


SCAM_SCORE_RE = re.compile(r"Fraud Score:\s*([0-9]+)")
SCAM_ROWS = (
    ("Anonymizing VPN", "anonymizing_vpn"),
    ("Tor Exit Node", "tor_exit_node"),
    ("Server", "server"),
    ("Public Proxy", "public_proxy"),
    ("Web Proxy", "web_proxy"),
)


def scam_row(html: str, label: str) -> bool | None:
    """Find a label, then the first Yes/No after it, without assuming markup.

    Written tag-agnostically on purpose: the exact `<th>`/`<td>` shape is
    nobody's promise to us, and a regex that is too specific fails by
    returning None -- which reads as "not a VPN" and is a false clean.
    """
    m = re.search(re.escape(label), html, re.IGNORECASE)
    if not m:
        return None
    window = html[m.end(): m.end() + 400]
    v = re.search(r">\s*(Yes|No)\s*<", window, re.IGNORECASE)
    return (v.group(1).lower() == "yes") if v else None


def feed_scamalytics(ip: str) -> dict[str, Any]:
    """Scraped from the public per-IP page.  Optional, and it will fail often.

    There is no free API, the page sits behind Cloudflare bot protection, and
    a run of six lookups is enough to trip it.  When that happens this raises
    rather than returning a page full of Nones -- a feed that cannot answer
    must say so, because "we could not tell" and "not a VPN" are the two
    things this whole script exists to keep apart.  No attempt is made to
    work around the block.
    """
    html = http_get(f"https://scamalytics.com/ip/{ip}", accept_json=False)
    if "cf-error-details" in html or "you have been blocked" in html.lower():
        raise FeedError("refused by the site's bot protection (not retried on purpose)")
    m = SCAM_SCORE_RE.search(html)
    if not m:
        raise FeedError("could not find a fraud score in the page")
    out: dict[str, Any] = {"score": int(m.group(1))}
    for label, key in SCAM_ROWS:
        out[key] = scam_row(html, label)
    if out["anonymizing_vpn"] is None:
        # The score alone is not the signal; the anonymiser row is.
        raise FeedError("page parsed but the 'Anonymizing VPN' row did not -- "
                        "markup probably changed; treat as unknown, not as clean")
    return out


def feed_rdns(ip: str) -> dict[str, Any]:
    rev = ".".join(reversed(ip.split("."))) + ".in-addr.arpa"
    d = http_get(f"https://dns.google/resolve?name={rev}&type=PTR")
    if not isinstance(d, dict) or "Status" not in d:
        raise FeedError("unexpected payload")
    names = [a["data"].rstrip(".") for a in d.get("Answer", []) if a.get("type") == 12]
    return {"ptr": names or None}


# --------------------------------------------------------------------------
# blocklists
# --------------------------------------------------------------------------

def load_x4bnet(cache_dir: Path) -> dict[str, list[Any]]:
    """Free, local, and the one membership test that costs no API budget."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    lists: dict[str, list[Any]] = {}
    for key, url in (("vpn", X4BNET_VPN_URL), ("datacenter", X4BNET_DC_URL)):
        path = cache_dir / f"x4bnet-{key}-ipv4.txt"
        fresh = path.exists() and (time.time() - path.stat().st_mtime) < X4BNET_MAX_AGE_S
        if not fresh:
            try:
                body = http_get(url, timeout=60, accept_json=False)
                path.write_text(body, encoding="utf-8")
            except FeedError:
                if not path.exists():
                    raise
                # A stale copy beats no copy, but the caller must be told.
        nets = []
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                nets.append(ipaddress.ip_network(line, strict=False))
            except ValueError:
                continue
        lists[key] = nets
    return lists


def in_lists(ip: str, nets: list[Any]) -> bool:
    addr = ipaddress.ip_address(ip)
    return any(addr in n for n in nets)


# --------------------------------------------------------------------------
# certificate transparency
# --------------------------------------------------------------------------

def ct_names(domain: str) -> list[str]:
    """certspotter first: crt.sh is the better-known endpoint and the less
    reliable one -- it answered 404 and then 502 while this was written."""
    try:
        d = http_get(
            "https://api.certspotter.com/v1/issuances"
            f"?domain={domain}&include_subdomains=true&expand=dns_names",
            timeout=45,
        )
        if isinstance(d, list):
            names = {n for e in d for n in e.get("dns_names", [])}
            return sorted(names)
        raise FeedError(str(d))
    except FeedError:
        d = http_get(f"https://crt.sh/?q=%25.{domain}&output=json", timeout=90)
        if not isinstance(d, list):
            raise FeedError("crt.sh did not return a list")
        names: set[str] = set()
        for e in d:
            for n in (e.get("name_value") or "").split("\n"):
                if n.strip():
                    names.add(n.strip())
        return sorted(names)


# --------------------------------------------------------------------------
# adverse-flag evaluation
# --------------------------------------------------------------------------

def adverse_flags(node: dict[str, Any]) -> list[str]:
    """The flags that mean "a game or an anti-fraud vendor may treat this
    address as an anonymiser".

    Deliberately absent: `is_datacenter`, ip-api's `hosting`, the X4BNet
    *datacenter* list and Scamalytics' `Server` row.  Those are permanent
    properties of renting a server, every competitor including ExitLag
    carries them, and tracking them produces an alert that can never be
    cleared.  The datacenter-range risk is real but it is a *routing*
    decision, not a monitoring one -- see docs/design/ban-safety.md.
    """
    out: list[str] = []
    f = node.get("feeds", {})

    ipapi = f.get("ipapi_is", {}).get("data") or {}
    for key in ("is_vpn", "is_proxy", "is_abuser", "is_tor"):
        if ipapi.get(key) is True:
            out.append(f"ipapi.is:{key}")

    ipapic = f.get("ip_api_com", {}).get("data") or {}
    if ipapic.get("proxy") is True:
        out.append("ip-api.com:proxy")

    pc = f.get("proxycheck_io", {}).get("data") or {}
    if str(pc.get("proxy", "")).lower() == "yes":
        out.append("proxycheck.io:proxy")

    sc = f.get("scamalytics", {}).get("data") or {}
    if sc.get("anonymizing_vpn") is True:
        out.append("scamalytics:anonymizing_vpn")
    if sc.get("public_proxy") is True:
        out.append("scamalytics:public_proxy")

    if node.get("blocklists", {}).get("x4bnet_vpn") is True:
        out.append("x4bnet:vpn_list")

    ptr = (f.get("rdns", {}).get("data") or {}).get("ptr") or []
    for name in ptr:
        low = name.lower()
        if any(t in low for t in ("neoxify", "vpn", "proxy", "tunnel", "exit-", "relay")):
            out.append("rdns:brand_or_role_in_ptr")
            break

    return sorted(set(out))


# --------------------------------------------------------------------------
# run
# --------------------------------------------------------------------------

def check_node(row: dict[str, str], x4b: dict[str, list[Any]], *,
               skip_optional: bool, pause: float) -> dict[str, Any]:
    ip = row["address"]
    node: dict[str, Any] = {
        "name": row["name"], "role": row.get("role", ""),
        "region": row.get("region", ""), "status": row.get("status", ""),
        "address": ip, "feeds": {}, "blocklists": {},
    }

    try:
        ipaddress.ip_address(ip)
    except ValueError:
        node["feeds"] = {k: {"status": "error", "error": "node source gave something "
                                                        "that is not an IP address"}
                         for k in REQUIRED_FEEDS}
        node["adverse"] = []
        return node

    feeds: list[tuple[str, Any]] = [
        ("ipapi_is", feed_ipapi_is),
        ("ip_api_com", feed_ip_api_com),
        ("rdns", feed_rdns),
    ]
    if not skip_optional:
        feeds += [("proxycheck_io", feed_proxycheck_io), ("scamalytics", feed_scamalytics)]

    for key, fn in feeds:
        try:
            node["feeds"][key] = {"status": "ok", "data": fn(ip)}
        except FeedError as exc:
            node["feeds"][key] = {"status": "error", "error": str(exc)}
        except Exception as exc:  # a feed must never take the run down
            node["feeds"][key] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        # ip-api.com allows 45/min unkeyed; stay well under it.
        time.sleep(pause)

    try:
        node["blocklists"] = {
            "x4bnet_vpn": in_lists(ip, x4b["vpn"]),
            "x4bnet_datacenter": in_lists(ip, x4b["datacenter"]),
        }
        node["feeds"]["x4bnet"] = {"status": "ok"}
    except Exception as exc:
        node["feeds"]["x4bnet"] = {"status": "error", "error": str(exc)}

    node["adverse"] = adverse_flags(node)
    return node


def load_publisher_blocks() -> dict[str, Any]:
    if not PUBLISHER_BLOCKS_PATH.exists():
        return {"byAsn": {}, "byCidr": {}}
    try:
        return json.loads(PUBLISHER_BLOCKS_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(
            f"check-exit-reputation: {PUBLISHER_BLOCKS_PATH.name} is not valid JSON: {exc}")


def publisher_incidents(node: dict[str, Any], table: dict[str, Any]) -> list[dict[str, Any]]:
    """Documented publisher blocks on record for the range this exit sits in.

    Advisory, never a verdict.  Every entry carries its own evidence level
    and its own status, and today exactly one ASN in the whole table has an
    entry at all -- reactive, and resolved in 2019.  Reading this as "these
    exits are blocked" would be the same overreach the table's own notes warn
    about.
    """
    out: list[dict[str, Any]] = []
    asn = (node.get("feeds", {}).get("ipapi_is", {}).get("data") or {}).get("asn_num")
    if asn is not None:
        entry = (table.get("byAsn") or {}).get(str(asn))
        if entry:
            for inc in entry.get("incidents", []):
                out.append({"scope": f"AS{asn} {entry.get('provider', '')}".strip(), **inc})

    addr = node.get("address")
    if addr:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            ip = None
        if ip is not None:
            for cidr, entry in (table.get("byCidr") or {}).items():
                try:
                    if ip in ipaddress.ip_network(cidr, strict=False):
                        for inc in entry.get("incidents", []):
                            out.append({"scope": cidr, **inc})
                except ValueError:
                    continue
    return out


def load_baseline() -> dict[str, Any]:
    if not BASELINE_PATH.exists():
        return {"accepted": {}}
    try:
        return json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"check-exit-reputation: {BASELINE_PATH.name} is not valid JSON: {exc}")


def previous_artifact(artifact_dir: Path, current: Path) -> Path | None:
    if not artifact_dir.exists():
        return None
    files = sorted(p for p in artifact_dir.glob("*.json") if p != current)
    return files[-1] if files else None


FLAG_FEED = {
    "ipapi.is": "ipapi_is",
    "ip-api.com": "ip_api_com",
    "proxycheck.io": "proxycheck_io",
    "scamalytics": "scamalytics",
    "x4bnet": "x4bnet",
    "rdns": "rdns",
}


def answered(node: dict[str, Any], flag: str) -> bool:
    """Did the feed behind this flag actually answer in this run?"""
    feed = FLAG_FEED.get(flag.split(":", 1)[0])
    if feed is None:
        return True
    return node.get("feeds", {}).get(feed, {}).get("status") == "ok"


def semantic_diff(prev: dict[str, Any], cur: dict[str, Any]) -> list[str]:
    """What changed, ignoring timestamps.  The whole value of the artifact.

    A feed that was skipped or that errored must never diff as a flag being
    *cleared*, and a skipped CT check must never diff as names disappearing.
    Comparing a measurement against a non-measurement is the same mistake as
    reading a failed check as a pass, one step further downstream.
    """
    lines: list[str] = []
    pn = {n["name"]: n for n in prev.get("nodes", [])}
    cn = {n["name"]: n for n in cur.get("nodes", [])}

    for name in sorted(set(cn) - set(pn)):
        lines.append(f"  + node {name} is new since the last run")
    for name in sorted(set(pn) - set(cn)):
        lines.append(f"  - node {name} is gone since the last run")

    for name in sorted(set(pn) & set(cn)):
        before, after = set(pn[name].get("adverse", [])), set(cn[name].get("adverse", []))
        for f in sorted(after - before):
            if answered(pn[name], f):
                lines.append(f"  ! {name}: NEW adverse flag {f}")
            else:
                lines.append(f"  ! {name}: adverse flag {f} -- first reading, "
                             f"that feed did not answer last time")
        for f in sorted(before - after):
            if answered(cn[name], f):
                lines.append(f"  . {name}: adverse flag cleared: {f}")
            # else: the feed simply did not answer this time. Not a clearance;
            # the DEGRADED / INCOMPLETE sections already say so.
        pa = (pn[name].get("feeds", {}).get("ipapi_is", {}).get("data") or {}).get("asn_num")
        ca = (cn[name].get("feeds", {}).get("ipapi_is", {}).get("data") or {}).get("asn_num")
        if pa and ca and pa != ca:
            lines.append(f"  ! {name}: ASN changed AS{pa} -> AS{ca}")
        if pn[name].get("address") != cn[name].get("address"):
            lines.append(f"  ! {name}: address changed (rotation discards low-abuse history)")

    pc, cc = prev.get("ct", {}), cur.get("ct", {})
    if pc.get("status") == "ok" and cc.get("status") == "ok":
        pct, cct = set(pc.get("names", [])), set(cc.get("names", []))
        for n in sorted(cct - pct):
            lines.append(f"  ! certificate transparency: NEW name {n} -- a certificate "
                         f"was issued outside policy; the fleet just got easier to enumerate")
        for n in sorted(pct - cct):
            lines.append(f"  . certificate transparency: name no longer listed {n}")
    elif cc.get("status") == "skipped":
        lines.append("  (certificate transparency was skipped, so it was not compared)")

    return lines


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        prog="check-exit-reputation",
        description="Check every Neoxify exit against free IP-reputation feeds "
                    "and fail when one starts being labelled a VPN or a proxy.",
    )
    src = ap.add_argument_group("where the node list comes from")
    src.add_argument("--nodes-from", choices=("psql", "compose", "file", "args"),
                     default="psql")
    src.add_argument("--database-url", default=os.environ.get("DATABASE_URL"),
                     help="postgres URL for --nodes-from psql (default $DATABASE_URL)")
    src.add_argument("--compose-file", default="infra/docker-compose.prod.yml")
    src.add_argument("--env-file", default=None)
    src.add_argument("--nodes-file", type=Path,
                     help="TSV (name/role/region/ip/status) or JSON; keep it gitignored")
    src.add_argument("--node", action="append", default=[], metavar="NAME=IP",
                     help="ad-hoc node for --nodes-from args; repeatable")

    ap.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIR,
                    help="gitignored output directory (default var/exit-reputation)")
    ap.add_argument("--show-addresses", action="store_true",
                    help="print real addresses; off by default so output is paste-safe")
    ap.add_argument("--skip-optional", action="store_true",
                    help="skip proxycheck.io and Scamalytics (daily cap / HTML scrape)")
    ap.add_argument("--skip-ct", action="store_true",
                    help="skip the certificate-transparency enumerability check")
    ap.add_argument("--ct-domain", action="append", default=[],
                    help=f"domain to check in CT; repeatable (default {', '.join(DEFAULT_CT_DOMAINS)})")
    ap.add_argument("--pause", type=float, default=1.5,
                    help="seconds between lookups; ip-api.com allows 45/min unkeyed")
    args = ap.parse_args(argv)

    # ---- node list ----------------------------------------------------
    if args.nodes_from == "psql":
        if not args.database_url:
            ap.error("--nodes-from psql needs --database-url or $DATABASE_URL")
        rows = nodes_from_psql(args.database_url)
    elif args.nodes_from == "compose":
        rows = nodes_from_compose(args.compose_file, args.env_file)
    elif args.nodes_from == "file":
        if not args.nodes_file:
            ap.error("--nodes-from file needs --nodes-file")
        rows = nodes_from_file(args.nodes_file)
    else:
        if not args.node:
            ap.error("--nodes-from args needs at least one --node NAME=IP")
        rows = []
        for spec in args.node:
            name, _, ip = spec.partition("=")
            if not ip:
                ap.error(f"--node expects NAME=IP, got {spec!r}")
            rows.append({"name": name, "role": "", "region": "", "address": ip, "status": ""})

    if not rows:
        print("check-exit-reputation: the node source returned no rows.", file=sys.stderr)
        print("  That is a setup failure, not a clean fleet.", file=sys.stderr)
        return 3

    started = datetime.now(timezone.utc)
    artifact_dir: Path = args.artifact_dir
    artifact_dir.mkdir(parents=True, exist_ok=True)

    # ---- blocklists ---------------------------------------------------
    x4b_error = None
    try:
        x4b = load_x4bnet(artifact_dir / "cache")
    except Exception as exc:
        x4b, x4b_error = {"vpn": [], "datacenter": []}, str(exc)

    # ---- per-node -----------------------------------------------------
    nodes: list[dict[str, Any]] = []
    for row in rows:
        node = check_node(row, x4b, skip_optional=args.skip_optional, pause=args.pause)
        if x4b_error:
            node["feeds"]["x4bnet"] = {"status": "error", "error": x4b_error}
        nodes.append(node)

    # ---- certificate transparency -------------------------------------
    ct: dict[str, Any] = {"status": "skipped"}
    if not args.skip_ct:
        domains = args.ct_domain or list(DEFAULT_CT_DOMAINS)
        found: set[str] = set()
        errors: dict[str, str] = {}
        for d in domains:
            try:
                found.update(ct_names(d))
            except Exception as exc:
                errors[d] = str(exc)
        ct = {
            "status": "error" if errors and not found else "ok",
            "domains": domains,
            "names": sorted(found),
            "count": len(found),
            "errors": errors,
        }

    # ---- publisher blocks on record for these ranges -------------------
    blocks = load_publisher_blocks()
    for node in nodes:
        node["publisherIncidents"] = publisher_incidents(node, blocks)

    # ---- verdict ------------------------------------------------------
    baseline = load_baseline()
    accepted: dict[str, list[str]] = baseline.get("accepted", {})
    for node in nodes:
        ok = set(accepted.get(node["name"], []))
        node["unacknowledged"] = sorted(f for f in node["adverse"] if f not in ok)
        node["acknowledged"] = sorted(f for f in node["adverse"] if f in ok)

    incomplete: list[str] = []
    for node in nodes:
        for key in REQUIRED_FEEDS:
            st = node["feeds"].get(key, {}).get("status")
            if st != "ok":
                err = node["feeds"].get(key, {}).get("error", "not attempted")
                incomplete.append(f"{node['name']}: {key}: {err}")
    if ct.get("status") == "error":
        incomplete.append(f"certificate transparency: {ct.get('errors')}")

    # Optional-feed failures do not make the run unusable, but they must never
    # be invisible: a feed that did not answer is not a feed that said "clean".
    degraded: list[str] = []
    for node in nodes:
        for key in OPTIONAL_FEEDS:
            entry = node["feeds"].get(key)
            if entry is None:
                continue
            if entry.get("status") != "ok":
                degraded.append(f"{node['name']}: {key}: {entry.get('error')}")

    regressions = [f"{n['name']}: {f}" for n in nodes for f in n["unacknowledged"]]

    finished = datetime.now(timezone.utc)
    artifact = {
        "schema": 1,
        "run": {
            "startedAt": started.isoformat(timespec="seconds"),
            "finishedAt": finished.isoformat(timespec="seconds"),
            "tool": "scripts/check-exit-reputation.py",
            "complete": not incomplete,
            "optionalFeedsSkipped": bool(args.skip_optional),
        },
        "nodes": nodes,
        "ct": ct,
        "incomplete": incomplete,
        "degraded": degraded,
        "regressions": regressions,
    }

    path = artifact_dir / (started.strftime("%Y-%m-%dT%H%M%SZ") + ".json")
    prev_path = previous_artifact(artifact_dir, path)
    path.write_text(json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # ---- report -------------------------------------------------------
    out: list[str] = []
    out.append(f"exit reputation: {len(nodes)} node(s) checked at {started.isoformat(timespec='seconds')}")
    out.append("")
    hdr = f"  {'node':<12} {'role':<11} {'ASN':<9} {'type':<8} {'dc':<4} {'vpn':<4} {'proxy':<6} adverse"
    out.append(hdr)
    out.append("  " + "-" * (len(hdr) - 2))
    for n in nodes:
        d = n["feeds"].get("ipapi_is", {}).get("data") or {}
        c = n["feeds"].get("ip_api_com", {}).get("data") or {}
        def mark(v: Any) -> str:
            return "?" if v is None else ("yes" if v else "no")
        flags = ", ".join(n["adverse"]) or "-"
        if n["unacknowledged"]:
            flags += "   <== UNACKNOWLEDGED"
        out.append(
            f"  {n['name']:<12} {n.get('role',''):<11} "
            f"{('AS%s' % d.get('asn_num')) if d.get('asn_num') else '?':<9} "
            f"{c.get('asn_type','?'):<8} {mark(d.get('is_datacenter')):<4} "
            f"{mark(d.get('is_vpn')):<4} {mark(d.get('is_proxy')):<6} {flags}"
        )

    incidents = [(n["name"], i) for n in nodes for i in n.get("publisherIncidents", [])]
    if incidents:
        out.append("")
        out.append("  publisher blocks on record for these ranges "
                   "(advisory -- read the evidence level, not the headline):")
        for name, inc in incidents:
            out.append(f"    {name}: {inc.get('publisher')} -- {inc.get('mechanism')}, "
                       f"evidence: {inc.get('evidence')}, status: {inc.get('status')}"
                       f"{', ' + inc['when'] if inc.get('when') else ''}")
        out.append("    full text and caveats: scripts/publisher-blocks.json")
    else:
        out.append("")
        out.append("  publisher blocks on record for these ranges: none")

    ptrs = [(n["name"], p)
            for n in nodes
            for p in ((n["feeds"].get("rdns", {}).get("data") or {}).get("ptr") or [])]
    if ptrs:
        out.append("")
        out.append("  reverse DNS still set (the recommendation is empty, not a provider")
        out.append("  default -- docs/node-enumerability-remediation.md section 1):")
        for name, p in ptrs:
            out.append(f"    {name}: {p}")

    if ct.get("status") != "skipped":
        out.append("")
        out.append(f"  certificate transparency: {ct.get('count', 0)} distinct name(s) "
                   f"across {', '.join(ct.get('domains', []))}")
        out.append("  (every one of these resolves to an exit; this is the enumerability")
        out.append("   surface docs/node-enumerability-remediation.md is about)")

    prev_lines: list[str] = []
    if prev_path:
        try:
            prev = json.loads(prev_path.read_text(encoding="utf-8"))
            prev_lines = semantic_diff(prev, artifact)
        except json.JSONDecodeError:
            prev_lines = [f"  (could not read previous artifact {prev_path.name})"]
        out.append("")
        out.append(f"  compared against {prev_path.name}:")
        out.extend(prev_lines or ["    no change"])
    else:
        out.append("")
        out.append("  no previous artifact to compare against -- this run is the baseline.")

    out.append("")
    out.append(f"  artifact: {path}")

    if degraded:
        out.append("")
        out.append("  DEGRADED -- optional feeds that did not answer. These do not fail the")
        out.append("  run (proxycheck.io caps at 100 lookups/day unkeyed; Scamalytics sits")
        out.append("  behind bot protection), but they did not vote 'clean' either:")
        for line in degraded:
            out.append(f"    {line}")

    status = 0
    if incomplete:
        status = 2
        out.append("")
        out.append("  INCOMPLETE -- a required lookup failed, so this run cannot be read as")
        out.append("  'checked and clean'. Re-run before drawing any conclusion:")
        for line in incomplete:
            out.append(f"    {line}")
    if regressions:
        status = 1
        out.append("")
        out.append("  REGRESSION -- adverse flags that are not in scripts/exit-reputation-baseline.json:")
        for line in regressions:
            out.append(f"    {line}")
        out.append("")
        out.append("  This is the signal the whole check exists for. Read")
        out.append("  docs/design/ban-safety.md 'Newly flagged exit' before deciding what to do.")
        out.append("  Do NOT rotate the address to escape a flag -- rotation discards the")
        out.append("  low-abuse history that is the actual asset.")
    if status == 0:
        out.append("")
        out.append("  OK -- every required lookup succeeded and no exit carries an")
        out.append("  unacknowledged VPN, proxy or blocklist flag.")
        if degraded:
            out.append("  (with the degraded optional feeds above; corroboration is thinner")
            out.append("   than usual, the required feeds all answered)")

    text = "\n".join(out)
    if not args.show_addresses:
        text = redact(text, nodes)
    print(text)
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
