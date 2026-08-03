import { load, type Store } from "@tauri-apps/plugin-store";
import type { TokenPair } from "./types";

// Tokens are persisted to a local JSON file in the app's data directory
// (OS-protected by per-user file permissions, same baseline every other
// per-user app config on Windows gets) via Tauri's official store
// plugin -- not an OS credential vault (Windows Credential Manager,
// etc). That's a deliberate v1 simplification, not an oversight: wiring
// up a keychain-backed plugin is real extra work for a first pass whose
// main goal is proving the rest of the app end-to-end. Worth upgrading
// before this handles anything more sensitive than session tokens that
// already expire and rotate on their own.
let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // A rejected promise must not be cached: `??=` alone would remember the
  // failure for the life of the process, so one transient error (a
  // locked or half-written session.json) would permanently break saving
  // and clearing tokens even after the underlying problem cleared.
  storePromise ??= load("session.json", { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** The stored session, or null if there isn't one.
 *
 * A store that cannot be read is reported as "no session" rather than
 * thrown: the only caller is the app's startup check, and an unreadable
 * session.json means the customer signs in again -- which works --
 * whereas a rejection there left the app on "Loading..." forever with no
 * way out.
 */
export async function getTokens(): Promise<TokenPair | null> {
  try {
    const store = await getStore();
    const accessToken = await store.get<string>("accessToken");
    const refreshToken = await store.get<string>("refreshToken");
    if (!accessToken || !refreshToken) return null;
    return { accessToken, refreshToken };
  } catch {
    return null;
  }
}

export async function setTokens(tokens: TokenPair): Promise<void> {
  const store = await getStore();
  await store.set("accessToken", tokens.accessToken);
  await store.set("refreshToken", tokens.refreshToken);
  await store.save();
}

export async function clearTokens(): Promise<void> {
  const store = await getStore();
  await store.delete("accessToken");
  await store.delete("refreshToken");
  await store.save();
}
