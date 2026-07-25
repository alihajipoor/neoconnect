import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MapPin } from "lucide-react";
import { getMe, getProtocolUsers, getSubscriptions } from "../lib/customer";
import { logout } from "../lib/auth";
import type { Customer, ProtocolUser, Subscription } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { Button, Card } from "../components/ui";
import { Logo } from "../components/Logo";
import { LocationPicker } from "../components/LocationPicker";

type ConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting";

export function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Customer | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [protocolUser, setProtocolUser] = useState<ProtocolUser | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    setError(null);
    const [meResult, subsResult, usersResult] = await Promise.all([getMe(), getSubscriptions(), getProtocolUsers()]);

    if (!meResult.ok || !subsResult.ok || !usersResult.ok) {
      const failed = [meResult, subsResult, usersResult].find((r) => !r.ok);
      if (failed && !failed.ok && failed.sessionExpired) {
        onLoggedOut();
        return;
      }
      setError(!meResult.ok ? meResult.error : !subsResult.ok ? subsResult.error : "Could not load your account.");
      setLoading(false);
      return;
    }

    setMe(meResult.data);
    setSubscription(subsResult.data[0] ?? null);
    setProtocolUser(usersResult.data[0] ?? null);
    setLoading(false);

    // The tunnel outlives the app: the helper service keeps it up if the
    // window is closed, so on open the UI has to adopt whatever is
    // actually running rather than assuming disconnected. Failure here is
    // deliberately silent -- it just means "show disconnected", and the
    // real error surfaces on the next Connect attempt with context.
    try {
      const status = await invoke<{ connected: boolean }>("vpn_status");
      setConnectionState(status.connected ? "connected" : "disconnected");
    } catch {
      setConnectionState("disconnected");
    }
  }

  async function handleConnectToggle() {
    if (!protocolUser) return;
    setConnectionError(null);

    if (connectionState === "connected") {
      setConnectionState("disconnecting");
      try {
        await invoke("vpn_disconnect");
        setConnectionState("disconnected");
      } catch (err) {
        setConnectionError(String(err));
        setConnectionState("connected");
      }
      return;
    }

    setConnectionState("connecting");
    try {
      // The whole protocol-user row goes to the helper service, which
      // picks the right engine -- the app deliberately doesn't branch on
      // protocol here, so adding one later needs no change in the UI.
      await invoke("vpn_connect", { payload: protocolUser });
      setConnectionState("connected");
    } catch (err) {
      setConnectionError(String(err));
      setConnectionState("disconnected");
    }
  }

  async function handleLogout() {
    await logout();
    onLoggedOut();
  }

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="relative flex h-full flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <Logo />
        <Button variant="ghost" onClick={handleLogout} className="h-7 px-2 text-xs">
          Sign out
        </Button>
      </div>

      {error ? (
        <Card>
          <p className="text-sm text-destructive">{error}</p>
          <Button onClick={() => void loadAll()} className="mt-3">
            Retry
          </Button>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{me?.email}</p>

          {subscription ? (
            <Card className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Subscription</span>
                <span
                  className={
                    subscription.status === "ACTIVE"
                      ? "rounded-full bg-success/15 px-2 py-0.5 text-xs text-success"
                      : "rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive"
                  }
                >
                  {subscription.status}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Expires {new Date(subscription.expireAt).toLocaleDateString()}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(subscription.dataUsedBytes)} / {formatBytes(subscription.dataCapBytes)} used
              </p>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-muted-foreground">No active subscription yet.</p>
            </Card>
          )}

          <Card className="flex flex-1 flex-col items-center justify-center gap-4">
            {!protocolUser ? (
              <p className="text-center text-sm text-muted-foreground">
                No connection provisioned on your subscription yet.
              </p>
            ) : (
              <>
                <button
                  onClick={() => void handleConnectToggle()}
                  disabled={connectionState === "connecting" || connectionState === "disconnecting"}
                  className={
                    "flex size-28 items-center justify-center rounded-full text-sm font-semibold transition-colors disabled:opacity-60 " +
                    (connectionState === "connected"
                      ? "bg-success/20 text-success shadow-[0_0_40px_-8px_var(--success)]"
                      : "bg-primary/20 text-primary shadow-[0_0_40px_-8px_var(--primary)]")
                  }
                >
                  {connectionState === "connected" && "Connected"}
                  {connectionState === "disconnected" && "Connect"}
                  {connectionState === "connecting" && "Connecting..."}
                  {connectionState === "disconnecting" && "Disconnecting..."}
                </button>
                {connectionError ? <p className="text-xs text-destructive">{connectionError}</p> : null}
              </>
            )}
          </Card>

          {subscription ? (
            <Button
              variant="ghost"
              onClick={() => setShowLocationPicker(true)}
              disabled={connectionState !== "disconnected"}
              className="w-full justify-center gap-2 border border-white/10"
            >
              <MapPin className="size-4" />
              Change location
            </Button>
          ) : null}
        </>
      )}

      {showLocationPicker && subscription ? (
        <LocationPicker
          subscriptionId={subscription.id}
          currentRouteId={protocolUser?.routeId}
          onClose={() => setShowLocationPicker(false)}
          // Re-reads the provisioned connection rather than adopting the
          // switch response directly. Two reasons, one of which was a
          // real bug: the switch endpoint's payload didn't carry the
          // `connection` field that listing does, so switching servers
          // left the app holding credentials with no server address and
          // Connect failed. Re-fetching also means an app running
          // against an older backend still works, instead of depending
          // on that endpoint's exact shape.
          onSwitched={() => void loadAll()}
        />
      ) : null}
    </div>
  );
}
