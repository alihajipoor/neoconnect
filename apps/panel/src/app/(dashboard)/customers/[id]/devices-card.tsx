import type { CustomerDevice, InsightDeviceFacts } from "@/lib/types";
import { ago } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SignOutDeviceButton } from "./sign-out-device-button";
import { deviceFactsLine, factsByDevice, platformName, utcStamp } from "./diagnostics-format";

/** Every device this customer has signed in on, one row per session.
 *
 * Signed-out sessions stay in the list, below the live ones: "I signed
 * out of my old phone" and "my old phone is still holding a slot" are
 * both things a customer says, and only one of them is true.
 *
 * Under each device, what its newest reports said about it (model,
 * system, network, its own DNS settings) when the app sends that
 * (docs/client-diagnostics.md). Facts from a device with no row here --
 * a report that named no session, or one since pruned -- are listed
 * after the table by platform, so nothing an app reported is hidden. */
export function DevicesCard({
  customerId,
  devices,
  canSignOut,
  facts,
  window,
}: {
  customerId: string;
  /** Null when the activity endpoint failed. */
  devices: CustomerDevice[] | null;
  canSignOut: boolean;
  /** The insight's device facts; null when the insight failed to load. */
  facts: InsightDeviceFacts[] | null;
  /** The insight's window in words ("7 days"): facts come only from it. */
  window: string;
}) {
  const sorted = [...(devices ?? [])].sort(
    (a, b) =>
      Number(a.revoked) - Number(b.revoked) ||
      new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
  );
  const live = sorted.filter((device) => !device.revoked).length;
  const { bySession, unmatched } = factsByDevice(devices, facts);
  const columns = canSignOut ? 7 : 6;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          Devices
          {devices && devices.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {live} signed in
              {sorted.length > live && `, ${sorted.length - live} signed out`}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {devices === null ? (
          <p className="text-sm text-muted-foreground">Could not load this customer&apos;s devices.</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">Never signed in on any device.</p>
        ) : (
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Signed in via</TableHead>
                  <TableHead>First used</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  {canSignOut && <TableHead className="w-0" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((device) => {
                  const platform = platformName(device.platform);
                  const name = device.label ?? platform ?? "Unnamed device";
                  const deviceFacts = bySession.get(device.sessionId) ?? null;
                  // A signed-out device says nothing when it never
                  // reported; the "not yet" line is for live ones.
                  const showFacts = facts !== null && (deviceFacts !== null || !device.revoked);
                  return [
                    <TableRow
                      key={device.sessionId}
                      className={[device.revoked ? "opacity-60" : "", showFacts ? "sm:border-b-0" : ""].join(" ")}
                    >
                      <TableCell cell="primary">
                        <p className="text-sm">{name}</p>
                        {/* The label usually names the platform already
                            ("Android phone (Pixel 7)"); say it again only
                            when it does not. */}
                        {device.label && platform && !device.label.toLowerCase().includes(platform.toLowerCase()) && (
                          <p className="text-xs text-muted-foreground">{platform}</p>
                        )}
                      </TableCell>
                      <TableCell label="App" phoneOrder={2} className="text-sm whitespace-nowrap text-muted-foreground">
                        {device.appVersion ?? "—"}
                      </TableCell>
                      <TableCell label="Signed in via" phoneOrder={3} className="text-sm text-muted-foreground">
                        {/* The relay is the Iranian last-resort route: a
                            device that could only sign in that way is on
                            a network where the normal API is filtered. */}
                        {device.channel === "RELAY" ? (
                          <Badge variant="outline">Relay</Badge>
                        ) : device.channel === "NORMAL" ? (
                          "Normal"
                        ) : (
                          (device.channel ?? "—")
                        )}
                      </TableCell>
                      <TableCell label="First used" phoneOrder={4} className="text-sm whitespace-nowrap" title={new Date(device.createdAt).toLocaleString()}>
                        {new Date(device.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell label="Last used" phoneOrder={1} className="text-sm whitespace-nowrap" title={new Date(device.lastUsedAt).toLocaleString()}>
                        {ago(device.lastUsedAt)}
                      </TableCell>
                      <TableCell cell="status">
                        <Badge variant={device.revoked ? "secondary" : "success"}>
                          {device.revoked ? "Signed out" : "Signed in"}
                        </Badge>
                      </TableCell>
                      {/* On a phone the facts are one more labelled line of
                          the device's block; from 640px they are the row
                          under it (below). */}
                      {showFacts && (
                        <TableCell label="Device details" wide phoneOrder={8} className="sm:hidden">
                          <FactsLine facts={deviceFacts} window={window} />
                        </TableCell>
                      )}
                      {canSignOut && (
                        <TableCell phoneOrder={9} className="text-right">
                          {!device.revoked && (
                            <SignOutDeviceButton
                              customerId={customerId}
                              sessionId={device.sessionId}
                              device={name}
                            />
                          )}
                        </TableCell>
                      )}
                    </TableRow>,
                    showFacts && (
                      <TableRow
                        key={`${device.sessionId}-facts`}
                        className={["hover:bg-transparent max-sm:hidden", device.revoked ? "opacity-60" : ""].join(" ")}
                      >
                        <TableCell colSpan={columns} className="pt-0 whitespace-normal">
                          <FactsLine facts={deviceFacts} window={window} />
                        </TableCell>
                      </TableRow>
                    ),
                  ];
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {facts === null && devices !== null && devices.length > 0 && (
          <p className="text-xs text-muted-foreground">Could not load what the apps reported about these devices.</p>
        )}

        {unmatched.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              Also reported
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                by apps whose sign-in is not listed above
              </span>
            </h3>
            {unmatched.map((group) => (
              <div key={group.platform} className="rounded-lg border border-white/8 bg-card/40 px-3.5 py-2.5">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {platformName(group.platform)}
                </p>
                <ul className="mt-1 flex flex-col gap-2">
                  {group.facts.map((f, index) => (
                    <li key={`${f.sessionId ?? "none"}-${index}`} className="text-sm">
                      {f.label && <p>{f.label}</p>}
                      <FactsLine facts={f} window={window} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The facts as one quiet wrapped line, with when they were reported in
 * words and in UTC (a title never reaches a touch screen). */
function FactsLine({ facts, window }: { facts: InsightDeviceFacts | null; window: string }) {
  const parts = facts ? deviceFactsLine(facts) : [];
  if (!facts || parts.length === 0) {
    // No facts in the window is not proof the app cannot send them.
    return <p className="text-xs text-muted-foreground">No device details reported in the last {window}.</p>;
  }
  return (
    <p className="text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && (
            <span className="mx-1.5 text-white/25" aria-hidden="true">
              ·
            </span>
          )}
          <span className={part === "another VPN active" ? "text-amber-300" : "text-foreground/85"}>{part}</span>
        </span>
      ))}
      <span className="ml-2 whitespace-nowrap">
        reported {ago(facts.lastSeenAt)}, {utcStamp(facts.lastSeenAt)}
      </span>
    </p>
  );
}
