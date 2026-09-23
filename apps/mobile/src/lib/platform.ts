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
 * iOS runs the Xray engine in a packet-tunnel extension, and IKEv2
 * through the system's own client -- which needs no provider of ours at
 * all, and so is also the one protocol here with no extension memory
 * ceiling over it.
 *
 * WireGuard is the remaining gap. It would need its own provider built
 * and embedded, and until that exists, offering it would produce a
 * connection attempt that fails at the system boundary with a message
 * about configuration -- which reads as the customer's network being at
 * fault rather than the app lacking a feature.
 *
 * The ones iOS does support include all of those that work on filtered
 * networks, so the restriction costs the customers this is built for
 * nothing: IKEv2 is the most easily blocked of the three and is a
 * fallback for unfiltered networks, not the path into Iran.
 */
export const protocolSupported = (protocol: string): boolean => {
  if (!isIOS()) return true;
  return (
    protocol.startsWith("XRAY_") || protocol === "SHADOWSOCKS" || protocol === "IKEV2"
  );
};
