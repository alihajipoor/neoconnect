/** The `apiEndpoint` of an unreachable report, read back into entries.
 *
 * The apps render it as (endpoint-trace.ts `renderTrace`):
 *
 *     req: a.example=h401@820 b.example:2053=cancel@830; refresh: a.example=timeout@8001
 *
 * one `leg:` section per leg of the request, each address as
 * `host[:port]=outcome@milliseconds`; a `door:` section in the same form;
 * possibly a `[N cut]` mark where it was shortened to fit; and a
 * `probe:` section from the socket-level probe (control-plane-probe.ts),
 * kept here as its text. "none dialled" means nothing was tried. Builds
 * 0.9.39 to 0.9.43 sent a bare list of hostnames instead, comma or space
 * separated: those become entries with no leg and no outcome.
 *
 * Read tolerantly: whatever does not parse is kept as an entry with the
 * text as its target rather than dropped. */

export interface ApiTraceEntry {
  leg: string | null;
  target: string;
  outcome: string | null;
  ms: number | null;
}

export interface ApiTrace {
  entries: ApiTraceEntry[];
  /** The probe's section, without its "probe: " label. */
  probe: string | null;
  /** True for "none dialled": the request tried no address at all. */
  noneDialled: boolean;
  /** Entries left out to fit the field, from its `[N cut]` marks. */
  cut: number;
}

const ENTRY = /^(.+?)=([A-Za-z0-9_-]+)(?:@(\d+))?$/;

function entryOf(leg: string | null, text: string): ApiTraceEntry {
  const m = ENTRY.exec(text);
  if (!m) return { leg, target: text, outcome: null, ms: null };
  return { leg, target: m[1], outcome: m[2], ms: m[3] === undefined ? null : Number(m[3]) };
}

export function parseApiTrace(raw: string | null | undefined): ApiTrace | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const trace: ApiTrace = { entries: [], probe: null, noneDialled: false, cut: 0 };
  const probes: string[] = [];

  for (const sectionRaw of text.split(/;\s*/)) {
    const section = sectionRaw.trim();
    if (section === "") continue;
    if (section === "none dialled") {
      trace.noneDialled = true;
      continue;
    }
    const cut = /^\[(\d+) cut\]$/.exec(section);
    if (cut) {
      trace.cut += Number(cut[1]);
      continue;
    }
    const leg = /^([a-z]+):\s+([\s\S]*)$/.exec(section);
    if (leg) {
      if (leg[1] === "probe") {
        probes.push(leg[2].trim());
        continue;
      }
      for (const part of leg[2].split(/\s+/)) {
        if (part === "") continue;
        const inner = /^\[(\d+) cut\]$/.exec(part);
        if (inner) trace.cut += Number(inner[1]);
        else trace.entries.push(entryOf(leg[1], part));
      }
      continue;
    }
    // An older client's list of hostnames.
    for (const part of section.split(/[,\s]+/)) {
      if (part !== "") trace.entries.push({ leg: null, target: part, outcome: null, ms: null });
    }
  }
  trace.probe = probes.length > 0 ? probes.join("; ") : null;
  return trace;
}
