/** Which mobile platform this build is running on.
 *
 * Detected from the user agent rather than a plugin, matching how
 * `attempts.ts` already tells Android from Windows: both clients run in a
 * system webview, the Android one says so, and a wrong guess costs a
 * mislabelled row rather than a broken connection. Adding a native
 * dependency to two apps to improve on that is not worth it.
 *
 * iOS is the negative case on this build -- the mobile app ships for
 * Android and iOS only -- so it is inferred rather than matched. Matching
 * "iPhone" directly would miss iPad, and matching "Mac" would catch the
 * desktop webview, which shares this directory.
 */
export const isAndroid = (): boolean => /android/i.test(navigator.userAgent);

export const isIOS = (): boolean =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  // iPadOS reports itself as a Mac and is only distinguishable by having
  // a touchscreen, which no real Mac does.
  (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** Whether the platform can carry this protocol at all.
 *
 * iOS now carries the same set as Android, by three different routes:
 * Xray and WireGuard both run inside the one packet-tunnel extension --
 * iOS allows a tunnel extension only one principal class, so the
 * provider picks the engine from the profile it is handed -- while
 * IKEv2 goes through the system's own client and involves no extension
 * of ours at all.
 *
 * So nothing in the connect ladder is refused on iOS any more, and this
 * is now a guard rather than a restriction: it exists for the next
 * protocol added to that ladder, not for any protocol in it today.
 *
 * OPENVPN is the one it still refuses. There is no engine for it in
 * either mobile client, and it is not in the ladder either -- so this
 * never sees it in practice. It is named rather than left to the
 * default because the day it is added to the ladder, the honest answer
 * on iOS is still no, and a function that returned true for everything
 * would say yes.
 */
export const protocolSupported = (protocol: string): boolean => {
  if (!isIOS()) return true;
  return protocol !== "OPENVPN";
};
