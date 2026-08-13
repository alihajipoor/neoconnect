<?php
/**
 * Voucher short link: neoxify.net/r/ABCD1234EFGH
 *
 * Exists because a code has to reach someone who may have installed the
 * app from a store, where there is no voucher field at all -- the store
 * builds ship without one deliberately (Apple's 3.1.1 names "license
 * keys" as a prohibited unlock, and a reseller-sold code is a purchase
 * made outside the store, which a reviewer cannot distinguish from a
 * free giveaway). A link sidesteps the question entirely and is fewer
 * taps than typing twelve characters.
 *
 * Short and clean on purpose: this gets pasted into chat, read aloud,
 * and printed. /account/?voucher=... would work identically and look
 * like a tracking URL.
 *
 * All this does is normalise the code and hand it to the customer area,
 * which is where the real work happens. It deliberately does NOT look
 * the code up: this page is public and unauthenticated, and a lookup
 * here would turn it into an oracle for testing guessed codes at
 * whatever rate Apache will serve. The API's preview endpoint is rate
 * limited for exactly that reason; this is a redirect, nothing more.
 */

// No bootstrap: this file must not depend on locale resolution or the
// translation layer. It renders no UI and must survive being hit before
// anything else on the site is warm.
$code = '';

// The rewrite passes it as ?c=; the fallback path parses PATH_INFO so
// this still works on a host without mod_rewrite, where the URL arrives
// as /r/index.php/ABCD1234EFGH.
if (isset($_GET['c']) && is_string($_GET['c'])) {
    $code = $_GET['c'];
} elseif (isset($_SERVER['PATH_INFO']) && is_string($_SERVER['PATH_INFO'])) {
    $code = ltrim($_SERVER['PATH_INFO'], '/');
}

// Uppercased and stripped of the spaces and dashes people add when
// reading a code aloud, matching normalise() in the backend's
// voucher-code.ts so "abcd-efgh 1234" reaches the same voucher.
$code = strtoupper(preg_replace('/[\s-]/', '', $code));

// Whitelist rather than escape. The code alphabet is A-Z and 2-9 (no
// O/0 or I/1, which people confuse), so anything else is a typo or an
// injection attempt, and neither should be forwarded. Length-bounded so
// a megabyte of junk cannot be reflected into a redirect header.
if ($code === '' || !preg_match('/^[A-Z0-9]{1,32}$/', $code)) {
    // No code, or a malformed one: send them to the account area with
    // nothing prefilled rather than showing an error page. Someone who
    // mistyped a link can still sign in and type the code by hand, which
    // is a better outcome than a dead end.
    header('Location: /account/', true, 302);
    exit;
}

// 302, not 301. A permanent redirect would be cached by the browser and
// by intermediaries, and this URL's meaning is per-code -- caching one
// is harmless today but the moment the destination changes (a different
// portal path, say) every previously-issued link would keep going to the
// old place, from caches we cannot reach.
header('Location: /account/?voucher=' . rawurlencode($code), true, 302);

// Not indexable: a voucher code in a search result is a voucher code
// given away.
header('X-Robots-Tag: noindex, nofollow', true);
exit;
