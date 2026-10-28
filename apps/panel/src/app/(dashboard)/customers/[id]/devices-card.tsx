import type { CustomerDevice } from "@/lib/types";
import { ago } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SignOutDeviceButton } from "./sign-out-device-button";

const PLATFORMS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

/** Every device this customer has signed in on, one row per session.
 *
 * Signed-out sessions stay in the list, below the live ones: "I signed
 * out of my old phone" and "my old phone is still holding a slot" are
 * both things a customer says, and only one of them is true. */
export function DevicesCard({
  customerId,
  devices,
  canSignOut,
}: {
  customerId: string;
  /** Null when the activity endpoint failed. */
  devices: CustomerDevice[] | null;
  canSignOut: boolean;
}) {
  const sorted = [...(devices ?? [])].sort(
    (a, b) =>
      Number(a.revoked) - Number(b.revoked) ||
      new Date(b.lastUsedAt).getTime() - new Date(a.lastUsedAt).getTime(),
  );
  const live = sorted.filter((device) => !device.revoked).length;

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
      <CardContent>
        {devices === null ? (
          <p className="text-sm text-muted-foreground">Could not load this customer&apos;s devices.</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">Never signed in on any device.</p>
        ) : (
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table>
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
                  const platform = device.platform
                    ? (PLATFORMS[device.platform] ?? device.platform)
                    : null;
                  const name = device.label ?? platform ?? "Unnamed device";
                  return (
                    <TableRow key={device.sessionId} className={device.revoked ? "opacity-60" : undefined}>
                      <TableCell>
                        <p className="text-sm">{name}</p>
                        {/* The label usually names the platform already
                            ("Android phone (Pixel 7)"); say it again only
                            when it does not. */}
                        {device.label && platform && !device.label.toLowerCase().includes(platform.toLowerCase()) && (
                          <p className="text-xs text-muted-foreground">{platform}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap text-muted-foreground">
                        {device.appVersion ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
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
                      <TableCell className="text-sm whitespace-nowrap" title={new Date(device.createdAt).toLocaleString()}>
                        {new Date(device.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-sm whitespace-nowrap" title={new Date(device.lastUsedAt).toLocaleString()}>
                        {ago(device.lastUsedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={device.revoked ? "secondary" : "success"}>
                          {device.revoked ? "Signed out" : "Signed in"}
                        </Badge>
                      </TableCell>
                      {canSignOut && (
                        <TableCell className="text-right">
                          {!device.revoked && (
                            <SignOutDeviceButton
                              customerId={customerId}
                              sessionId={device.sessionId}
                              device={name}
                            />
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
