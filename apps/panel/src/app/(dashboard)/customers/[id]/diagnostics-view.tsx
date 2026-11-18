import Link from "next/link";
import { apiFetch, apiFetchList } from "@/lib/api";
import type { CustomerActivity, CustomerDevice, CustomerDiagnostics } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Pager } from "@/components/dashboard/pager";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyTextButton } from "./copy-text-button";
import { diagnosticsHref, platformName, utcStamp } from "./diagnostics-format";
import { ReportDetailsBlock } from "./report-details";
import { FoldedText, Muted, Section, TableBox, When, orNull } from "./view-parts";

/** The bundles a customer sent with "Send diagnostics", and one of them
 * opened: the one whose reference is in the link (the history's
 * DIAGNOSTICS_SENT events link here), else the newest. Bundles are kept
 * 60 days (docs/client-diagnostics.md). */
export async function DiagnosticsView({
  customerId,
  reference,
  take,
  skip,
}: {
  customerId: string;
  reference: string | undefined;
  take: number;
  skip: number;
}) {
  const id = encodeURIComponent(customerId);
  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));
  const [page, activity] = await Promise.all([
    orNull(apiFetchList<CustomerDiagnostics>(`/customers/${id}/diagnostics?${query.toString()}`)),
    // Only to name the device a bundle came from; without it the
    // platform is said instead.
    orNull(apiFetch<CustomerActivity>(`/customers/${id}/activity?attemptsTake=1`)),
  ]);

  if (page === null) {
    return (
      <Section title="Diagnostics">
        <Muted>Could not load this customer&apos;s diagnostics bundles.</Muted>
      </Section>
    );
  }
  if (page.total === 0 && skip === 0) {
    return (
      <Section title="Diagnostics">
        <Muted>
          No diagnostics bundle received from this customer. A customer sends one from the app with &ldquo;Send
          diagnostics&rdquo; and quotes the reference it shows; this app version does not offer it yet.
        </Muted>
      </Section>
    );
  }

  const devices = activity?.devices ?? [];
  const selected = reference
    ? (page.items.find((b) => b.reference.toLowerCase() === reference || b.id.toLowerCase() === reference) ?? null)
    : (page.items[0] ?? null);

  return (
    <>
      {reference && !selected ? (
        <Section title={`Bundle ${reference}`}>
          <Muted>
            No bundle with this reference on this page of the list. It may be on another page, or older than the 60
            days bundles are kept.
          </Muted>
        </Section>
      ) : (
        selected && <BundleCard bundle={selected} device={deviceName(selected, devices)} newest={!reference} />
      )}

      <Section
        title="Diagnostics bundles"
        note={`${page.total.toLocaleString()} sent, newest first, kept 60 days`}
      >
        <TableBox>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Sent</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((bundle) => {
                const open = selected?.id === bundle.id;
                return (
                  <TableRow key={bundle.id} className={cn(open && "bg-white/[0.04]")}>
                    <TableCell cell="primary" className="text-sm">
                      <Link
                        href={diagnosticsHref(customerId, bundle.reference)}
                        aria-current={open ? "true" : undefined}
                        className="inline-flex min-h-8 items-center font-mono underline-offset-2 hover:underline max-lg:min-h-10"
                      >
                        {bundle.reference}
                      </Link>
                      {open && <span className="ml-2 text-xs text-muted-foreground">shown above</span>}
                    </TableCell>
                    <TableCell label="Sent" phoneOrder={1} className="text-sm">
                      <When at={bundle.createdAt} />
                      <span className="block text-[11px] text-muted-foreground">{utcStamp(bundle.createdAt)}</span>
                    </TableCell>
                    <TableCell label="Device" phoneOrder={2} className="text-sm">
                      {deviceName(bundle, devices)}
                    </TableCell>
                    <TableCell label="App" phoneOrder={3} className="text-sm whitespace-nowrap text-muted-foreground">
                      {bundle.appVersion}
                    </TableCell>
                    <TableCell label="Note" wide phoneOrder={4} className="text-xs text-muted-foreground sm:w-full sm:max-w-0">
                      {bundle.note ? <FoldedText text={bundle.note} /> : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableBox>
        <Pager
          total={page.total}
          take={take}
          skip={skip}
          basePath={`/customers/${customerId}`}
          params={{ view: "diagnostics" }}
        />
      </Section>
    </>
  );
}

/** The device's sign-in label when the bundle's session is listed, else
 * the platform. */
function deviceName(bundle: CustomerDiagnostics, devices: CustomerDevice[]): string {
  const device = bundle.sessionId ? devices.find((d) => d.sessionId === bundle.sessionId) : undefined;
  const platform = platformName(bundle.platform) ?? bundle.platform;
  return device?.label ? `${device.label} (${platform})` : platform;
}

function BundleCard({ bundle, device, newest }: { bundle: CustomerDiagnostics; device: string; newest: boolean }) {
  const text = bundle.bundle?.platformDiagnostics ?? null;
  const details = bundle.bundle?.details ?? null;
  return (
    <Section
      title={
        <>
          Bundle <span className="font-mono">{bundle.reference}</span>
        </>
      }
      note={newest ? "the newest" : undefined}
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div className="min-w-0">
          <dt className={labelClass}>Sent</dt>
          <dd>
            <When at={bundle.createdAt} />
            <span className="block text-xs text-muted-foreground">{utcStamp(bundle.createdAt)}</span>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={labelClass}>Device</dt>
          <dd className="[overflow-wrap:anywhere]">{device}</dd>
        </div>
        <div className="min-w-0">
          <dt className={labelClass}>App</dt>
          <dd className="tabular-nums">
            {platformName(bundle.platform)} {bundle.appVersion}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className={labelClass}>Reference</dt>
          <dd className="font-mono">{bundle.reference}</dd>
        </div>
      </dl>

      <div>
        <p className={labelClass}>The customer&apos;s note</p>
        {bundle.note ? (
          <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{bundle.note}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No note.</p>
        )}
      </div>

      {details ? (
        <ReportDetailsBlock details={details} factsTitle="Device and network when sent" />
      ) : (
        <p className="text-sm text-muted-foreground">This bundle carried no device or network details.</p>
      )}

      <div className="min-w-0">
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className={labelClass}>The app&apos;s diagnostics text</p>
          {text && <CopyTextButton text={text} label="Copy text" />}
        </div>
        {text ? (
          <pre
            tabIndex={0}
            aria-label="The app's diagnostics text"
            className="max-h-96 overflow-auto rounded-md border border-white/8 bg-black/30 p-3 font-mono text-xs leading-5 whitespace-pre text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {text}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            None in this bundle. Only the Windows and Linux apps add it.
          </p>
        )}
      </div>
    </Section>
  );
}

const labelClass = "mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";
