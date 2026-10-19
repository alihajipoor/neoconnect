/** What the signed-in shell's pages share with the main page, in memory.
 *
 * The main page (Dashboard) reads the account and the plan; the other pages
 * of the shell -- Activity, Settings, Plans, Support, Invite friends -- show
 * the same avatar line without reading them again, so they take the last
 * thing the main page showed. Nothing here is stored or sent.
 *
 * "Locations" pressed on one of those pages leads back to the main page,
 * which shows its locations panel (or the phone's sheet) once it has
 * loaded: the request waits here for it. */

export interface ShellProfile {
  email: string | null;
  /** The days left and the plan's short name, as under the avatar. */
  planLine: string | null;
  /** The network the main page's map reads this device's history for
   * (lib/map-network.ts): null when it is not known; absent before the main
   * page has said. The Activity page uses the same, so the two agree. */
  network?: string | null;
}

let profile: ShellProfile = { email: null, planLine: null };
let locationsRequested = false;

export function rememberShellProfile(next: ShellProfile): void {
  profile = next;
}

export function shellProfile(): ShellProfile {
  return profile;
}

/** Forgotten at sign-out, so the next account never shows the last one's. */
export function forgetShellProfile(): void {
  profile = { email: null, planLine: null };
}

export function requestLocations(): void {
  locationsRequested = true;
}

/** Whether a request is waiting, clearing it. */
export function takeLocationsRequest(): boolean {
  const asked = locationsRequested;
  locationsRequested = false;
  return asked;
}
