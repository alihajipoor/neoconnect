/** Which channel this build was made for.
 *
 * One codebase, two shapes. A build destined for Google Play or the App
 * Store must not sell anything inside the app, and must not redeem a
 * voucher inside the app either -- both stores treat selling digital
 * goods in an app they distribute as theirs to govern, and Apple's
 * 3.1.1 names "license keys" explicitly as a prohibited unlock. A
 * reseller's code is a purchase made outside the store, and neither the
 * app nor a reviewer can tell it apart from a free giveaway code, so the
 * whole surface goes rather than half of it.
 *
 * Everything else is identical. Registration, sign-in, the free trial,
 * connecting, settings, support and account deletion are the same in
 * both, because none of them is a transaction and no store objects to
 * any of them. The point of a flag rather than a fork is that a feature
 * written once lands in both without anyone remembering to copy it.
 *
 * Defaults to `direct`, which is what makes the desktop client and the
 * sideloaded APK unaffected: they keep the purchase and voucher flows
 * exactly as they are today, because nobody distributes them but us.
 */
export type Distribution = "direct" | "store";

/* Read once at module load rather than per call. Vite substitutes
 * `import.meta.env.*` at build time, so this is a constant in the
 * bundle and the dead branch is eliminated -- the store build does not
 * merely hide the purchase screen, it does not contain it. That matters
 * for a reviewer looking at what shipped, not just for the customer. */
const configured = import.meta.env.VITE_DISTRIBUTION;

export const DISTRIBUTION: Distribution = configured === "store" ? "store" : "direct";

/** True only in builds submitted to Google Play or the App Store.
 *
 * Read this rather than comparing strings at call sites: an
 * accidentally misspelt `"stroe"` in a comparison silently means
 * "direct", which is the failure that ships purchase UI to a store and
 * gets the app removed. Here the misspelling can only happen once, in
 * the line above, where it is visible.
 */
export const IS_STORE_BUILD = DISTRIBUTION === "store";
