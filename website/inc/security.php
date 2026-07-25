<?php
/**
 * Form security primitives: a per-install secret, HMAC CSRF tokens, an IP
 * rate limiter, and the guarded-file helpers everything in data/ is written
 * through.
 *
 * Two constraints shape all of this:
 *
 *  1. No cookies. A marketing site that sets no cookies needs no cookie
 *     banner, so CSRF is done with a self-contained HMAC token instead of a
 *     PHP session.
 *  2. No CAPTCHA. The audience is largely in Iran, where reCAPTCHA is both a
 *     blocked third-party request and a bad experience. A honeypot plus a
 *     minimum fill time plus a rate limit stops the bots that actually target
 *     small PHP contact forms.
 */

defined('NX') || exit;

/**
 * Every file we write into data/ starts with this line. If the host ever
 * serves data/ as static files -- misconfiguration, an ignored .htaccess, a
 * control-panel change -- a direct request executes this and returns nothing
 * instead of dumping submissions to whoever asked. The .htaccess deny rule is
 * the second layer, not the only one.
 */
define('NX_FILE_GUARD', "<?php exit; ?>\n");


// ---------------------------------------------------------------------
// Guarded storage
// ---------------------------------------------------------------------

/**
 * Make sure data/ exists and is writable.
 *
 * @return bool false if submissions cannot be persisted
 */
function nx_data_ready()
{
    if (!is_dir(NX_DATA)) {
        // Suppressed: on a host where this fails we want the caller to fall
        // back gracefully, not to print a warning into the page body.
        @mkdir(NX_DATA, 0755, true);
    }
    return is_dir(NX_DATA) && is_writable(NX_DATA);
}

/**
 * Read a guarded file's real contents, with the guard line stripped.
 *
 * @param string $file
 * @return string '' when the file is missing or unreadable
 */
function nx_guarded_read($file)
{
    if (!is_file($file)) {
        return '';
    }
    $raw = @file_get_contents($file);
    if ($raw === false) {
        return '';
    }
    if (strpos($raw, NX_FILE_GUARD) === 0) {
        return substr($raw, strlen(NX_FILE_GUARD));
    }
    return $raw;
}

/**
 * Append a line to a guarded file, creating it with its guard if needed.
 *
 * @param string $file
 * @param string $line
 * @return bool
 */
function nx_guarded_append($file, $line)
{
    if (!nx_data_ready()) {
        return false;
    }

    $new = !is_file($file);
    $handle = @fopen($file, 'ab');
    if ($handle === false) {
        return false;
    }

    $ok = true;
    if (flock($handle, LOCK_EX)) {
        if ($new) {
            $ok = fwrite($handle, NX_FILE_GUARD) !== false;
        }
        $ok = $ok && fwrite($handle, $line . "\n") !== false;
        fflush($handle);
        flock($handle, LOCK_UN);
    } else {
        $ok = false;
    }
    fclose($handle);

    if ($new && $ok) {
        @chmod($file, 0640);
    }
    return $ok;
}


// ---------------------------------------------------------------------
// Per-install secret
// ---------------------------------------------------------------------

/**
 * The secret used to sign CSRF tokens.
 *
 * Generated on first use and cached in data/secret.php rather than being
 * something you have to remember to set -- an unconfigured site that silently
 * signs everything with a default value would be worse than useless. Stored
 * as a PHP file that returns the value, so a direct web request executes it
 * and outputs nothing.
 *
 * If data/ is not writable we fall back to a value derived from the install's
 * own path. Weaker, but it keeps the forms working on a locked-down host
 * instead of rejecting every legitimate submission.
 *
 * @return string
 */
function nx_secret()
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }

    $file = NX_DATA . '/secret.php';

    if (is_file($file)) {
        $value = @include $file;
        if (is_string($value) && strlen($value) >= 32) {
            $secret = $value;
            return $secret;
        }
    }

    $generated = bin2hex(random_bytes(32));

    if (nx_data_ready()) {
        $php = "<?php\n// Auto-generated. Do not edit, do not commit, do not"
             . " share.\nreturn '" . $generated . "';\n";
        if (@file_put_contents($file, $php, LOCK_EX) !== false) {
            @chmod($file, 0640);
            $secret = $generated;
            return $secret;
        }
    }

    $secret = hash('sha256', 'nx-fallback|' . NX_ROOT . '|' . PHP_VERSION);
    return $secret;
}


// ---------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------

/**
 * Issue a token for a form. The timestamp is part of the signed payload, so
 * the same token proves both "this came from a form we rendered" and "it was
 * rendered N seconds ago" -- which is also what the minimum-fill-time bot
 * check reads, with no second hidden field to keep in sync.
 *
 * @param string $form form name, so a contact token can't be replayed at the
 *                     reseller form
 * @return string
 */
function nx_csrf_token($form)
{
    $issued = time();
    return $issued . '.' . hash_hmac('sha256', $form . '|' . $issued, nx_secret());
}

/**
 * Validate a submitted token.
 *
 * @param string $form
 * @param string $token
 * @return int|false issue timestamp, or false if the token is not valid
 */
function nx_csrf_check($form, $token)
{
    if (!is_string($token) || strpos($token, '.') === false) {
        return false;
    }

    $parts = explode('.', $token, 2);
    $issued = (int) $parts[0];
    $signature = $parts[1];

    if ($issued <= 0) {
        return false;
    }

    $age = time() - $issued;
    // A token from the future means a clock problem or a forgery attempt.
    if ($age < 0 || $age > (int) nx_cfg('csrf_ttl', 7200)) {
        return false;
    }

    $expected = hash_hmac('sha256', $form . '|' . $issued, nx_secret());
    if (!hash_equals($expected, $signature)) {
        return false;
    }

    return $issued;
}


// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------

/**
 * The visitor's address.
 *
 * Deliberately REMOTE_ADDR only. X-Forwarded-For is trivially spoofable
 * unless you know exactly which proxy set it, and we don't know what sits in
 * front of this host -- trusting it would let anyone bypass the rate limit by
 * sending a header.
 *
 * @return string
 */
function nx_client_ip()
{
    return isset($_SERVER['REMOTE_ADDR']) ? (string) $_SERVER['REMOTE_ADDR'] : '0.0.0.0';
}

/**
 * Record an attempt and report whether the caller is within their limit.
 *
 * Addresses are stored only as salted hashes -- we never need to know who a
 * visitor is, only whether we've seen them too often, and a marketing site
 * has no business keeping a log of raw IPs.
 *
 * @param string $bucket form name
 * @return bool true if the submission is allowed to proceed
 */
function nx_rate_limit_ok($bucket)
{
    if (!nx_data_ready()) {
        // Can't track, so don't punish. The honeypot and CSRF checks still
        // apply; failing open here beats blocking every real visitor.
        return true;
    }

    $max = (int) nx_cfg('rate_limit_max', 5);
    $window = (int) nx_cfg('rate_limit_window', 3600);
    $now = time();
    $key = hash('sha256', $bucket . '|' . nx_client_ip() . '|' . nx_secret());

    $file = NX_DATA . '/ratelimit.php';
    $handle = @fopen($file, 'c+b');
    if ($handle === false) {
        return true;
    }

    $allowed = true;

    if (flock($handle, LOCK_EX)) {
        $raw = stream_get_contents($handle);
        if (strpos($raw, NX_FILE_GUARD) === 0) {
            $raw = substr($raw, strlen(NX_FILE_GUARD));
        }

        $hits = json_decode($raw, true);
        if (!is_array($hits)) {
            $hits = array();
        }

        // Drop everything outside the window, for every key -- this is what
        // keeps the file from growing without bound.
        $pruned = array();
        foreach ($hits as $hashed => $stamps) {
            if (!is_array($stamps)) {
                continue;
            }
            $keep = array();
            foreach ($stamps as $stamp) {
                if ($now - (int) $stamp < $window) {
                    $keep[] = (int) $stamp;
                }
            }
            if ($keep) {
                $pruned[$hashed] = $keep;
            }
        }

        $mine = isset($pruned[$key]) ? $pruned[$key] : array();
        $allowed = count($mine) < $max;

        $mine[] = $now;
        $pruned[$key] = $mine;

        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, NX_FILE_GUARD . json_encode($pruned));
        fflush($handle);
        flock($handle, LOCK_UN);
    }

    fclose($handle);
    return $allowed;
}


// ---------------------------------------------------------------------
// Honeypot
// ---------------------------------------------------------------------

/** Field name bots are invited to fill in. Never shown to real users. */
define('NX_HONEYPOT_FIELD', 'company_website');

/**
 * @return bool true if this submission looks like a bot
 */
function nx_honeypot_tripped()
{
    if (!isset($_POST[NX_HONEYPOT_FIELD])) {
        return false;
    }
    return trim((string) $_POST[NX_HONEYPOT_FIELD]) !== '';
}
