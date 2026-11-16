<?php
/**
 * Installer downloads served from this site: /get/windows and /get/android.
 *
 * WHY. The installer URLs in config.php are on the control plane's domain,
 * and networks that block VPNs often block that domain as well. Measured
 * 2026-11-14 from two boxes inside such a network: this site loaded, and
 * GitHub's release files moved, but the control plane did not answer at
 * all. So a visitor there reached the download page and the button failed.
 *
 * WHAT IT DOES. This site sits outside. On a request it asks the configured
 * installer URL where the current release is (without following it),
 * trusts that answer for installer_resolve_ttl seconds, fetches that file
 * ONCE into installer_store_dir (dl/, public), and redirects the visitor to
 * the copy on this site. The bookkeeping (the remembered answer, the lock,
 * the last failure) lives in installer_state_dir (data/installers). The
 * visitor's browser never needs another host.
 *
 * THE STATE FOLDER IS REACHABLE ON THE LIVE HOST. data/.htaccess denies it
 * on Apache, but the live box is nginx, which ignores .htaccess, so any file
 * there answers a direct request. So every state file is a .php file: the
 * remembered answer starts with the site's exit guard and is read by
 * stripping it, and the lock and failure marker are empty. A direct request
 * executes the file and gets an empty page, whatever the web server's
 * config. The older .json/.lock/.failed names are deleted on the first run. The site still
 * holds no version number: the answer comes from the same endpoint the
 * in-app updater uses, so a new release appears by itself.
 *
 * If anything at all goes wrong -- the endpoint does not answer, the answer
 * is not a release file, the fetch fails, the disk is full -- the visitor is
 * sent to the configured installer URL, exactly as before this file
 * existed. The button is never dead.
 *
 * Rules this keeps, and why each one matters:
 *  - Fixed platform keys only. The redirect target is never taken from the
 *    request, so this is not an open redirect.
 *  - The release answer must be https, start with installer_release_prefix
 *    and name a <tag>/<file> of the right type; every hop of the file fetch
 *    must be https on installer_release_hosts. No other address is ever
 *    fetched (no SSRF).
 *  - Tag and file name reduced to [A-Za-z0-9._-], never starting with a
 *    dot, so neither can climb out of the folder.
 *  - One fetch at a time per platform (flock). A second visitor waits for
 *    the first fetch, then gets the copy -- or the fallback.
 *  - Written to a temporary name, checked against Content-Length, the size
 *    cap and the file type's first bytes, then renamed. A partial file is
 *    never served.
 *  - ignore_user_abort: a visitor who gives up does not leave a half fetch.
 *  - Two newest copies kept per platform, older ones deleted.
 *  - One time budget for the whole request (asking, waiting, fetching), so
 *    the visitor gets an answer before the gateway timeout.
 *  - If the release endpoint cannot be asked, the last copy on disk is
 *    served rather than the fallback, which is that same blocked address.
 *
 * The copies are served by the web server as static files, which is what
 * keeps a slow download from tying up a PHP worker on a shared host.
 *
 * From the command line, `php get/index.php warm [windows|android]` does
 * the same fetch with no visitor waiting -- for a deploy check or a cron job.
 *
 * PHP 7.4 compatible, like the rest of the site. Needs the curl extension;
 * without it every request takes the fallback.
 */

define('NX', 1);
$NX_GET_CFG = require dirname(__DIR__) . '/inc/config.php';
$GLOBALS['NX_CFG'] = $NX_GET_CFG;

/** @return mixed */
function nxg_cfg($key, $default)
{
    global $NX_GET_CFG;
    return array_key_exists($key, $NX_GET_CFG) ? $NX_GET_CFG[$key] : $default;
}

/** The platforms, and what their file must look like. Nothing else is accepted. */
function nxg_platforms()
{
    return array(
        'windows' => array('cfg' => 'windows_installer_url', 'ext' => 'exe', 'magic' => 'MZ'),
        'android' => array('cfg' => 'android_installer_url', 'ext' => 'apk', 'magic' => "PK\x03\x04"),
    );
}

/** Reduce a name to [A-Za-z0-9._-]; '' if nothing safe is left. */
function nxg_safe_name($s)
{
    $s = preg_replace('/[^A-Za-z0-9._-]/', '', (string) $s);
    if ($s === '' || $s[0] === '.' || strlen($s) > 100) {
        return '';
    }
    return $s;
}

/** Whether a URL is https on an allowed release host. */
function nxg_allowed_host($url)
{
    $p = parse_url((string) $url);
    if (!is_array($p) || !isset($p['scheme'], $p['host']) || strtolower($p['scheme']) !== 'https') {
        return false;
    }
    if (isset($p['user']) || isset($p['pass']) || (isset($p['port']) && (int) $p['port'] !== 443)) {
        return false;
    }
    $hosts = array_map('strtolower', (array) nxg_cfg('installer_release_hosts', array()));
    return in_array(strtolower($p['host']), $hosts, true);
}

/** A curl handle with the settings every request here shares. */
function nxg_curl($url, $timeout)
{
    $timeout = max(1, (int) $timeout);
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
    curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, min(10, $timeout));
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    curl_setopt($ch, CURLOPT_USERAGENT, 'neoxify.net-download');
    return $ch;
}

/**
 * Ask the configured installer URL where the current release is.
 *
 * @return array|null array('url', 'tag', 'file') or null
 */
function nxg_resolve($platform, $upstream, $timeout)
{
    $meta = nxg_platforms();
    $meta = $meta[$platform];
    $ch = nxg_curl($upstream, min(15, $timeout));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $loc = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
    curl_close($ch);
    if ($code < 300 || $code > 399 || $loc === '') {
        return null;
    }

    $prefix = (string) nxg_cfg('installer_release_prefix', '');
    if ($prefix === '' || strpos($loc, $prefix) !== 0 || !nxg_allowed_host($loc)) {
        return null;
    }
    $rest = (string) parse_url(substr($loc, strlen($prefix) - 1), PHP_URL_PATH);
    $parts = explode('/', trim(rawurldecode($rest), '/'));
    if (count($parts) !== 2) {
        return null;
    }
    $tag = nxg_safe_name($parts[0]);
    $file = nxg_safe_name($parts[1]);
    if ($tag === '' || $file === '' || strtolower(pathinfo($file, PATHINFO_EXTENSION)) !== $meta['ext']) {
        return null;
    }
    return array('url' => $loc, 'tag' => $tag, 'file' => $file);
}

/** A folder under the site root named by a config key; '' when the value is unsafe. */
function nxg_rel_dir($key, $default)
{
    $rel = trim(str_replace('\\', '/', (string) nxg_cfg($key, $default)), '/');
    if ($rel === '' || strpos('/' . $rel . '/', '/../') !== false || strpos('/' . $rel . '/', '/./') !== false) {
        return '';
    }
    return $rel;
}

/** The public folder the copies are served from. */
function nxg_store()
{
    return nxg_dir('installer_store_dir', 'dl');
}

/** The private folder for the remembered answer, the lock and the last failure. */
function nxg_state()
{
    return nxg_dir('installer_state_dir', 'data/installers');
}

/** Absolute writable folder for a config key; created if missing. '' when unusable. */
function nxg_dir($key, $default)
{
    $rel = nxg_rel_dir($key, $default);
    if ($rel === '') {
        return '';
    }
    $dir = dirname(__DIR__) . '/' . $rel;
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        return '';
    }
    return is_writable($dir) ? $dir : '';
}

/** Public URL of a copy. */
function nxg_public_url($platform, $tag, $file)
{
    $rel = nxg_rel_dir('installer_store_dir', 'dl');
    return nxg_cfg('base_path', '/') . $rel . '/' . $platform . '/' . rawurlencode($tag) . '/' . rawurlencode($file);
}

/** First line of every state file with content: a direct request runs it and gets nothing. */
define('NXG_GUARD', "<?php exit; ?>
");

/** A state file's data, or null when it is missing, unguarded or not JSON. */
function nxg_state_read($path)
{
    $raw = is_file($path) ? (string) @file_get_contents($path) : '';
    if (strncmp($raw, NXG_GUARD, strlen(NXG_GUARD)) !== 0) {
        return null;
    }
    $v = json_decode(substr($raw, strlen(NXG_GUARD)), true);
    return is_array($v) ? $v : null;
}

/** Delete the state files of the first version, which a direct request could read. */
function nxg_state_legacy($state, $platform)
{
    foreach (array('.json', '.lock', '.failed') as $ext) {
        if (is_file($state . '/' . $platform . $ext)) {
            @unlink($state . '/' . $platform . $ext);
        }
    }
    foreach ((array) @glob($state . '/' . $platform . '.json.tmp-*') as $f) {
        if (is_string($f) && is_file($f)) {
            @unlink($f);
        }
    }
}

/** Write a small file atomically. The temporary name ends in .php as well. */
function nxg_write($path, $data)
{
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4)) . '.php';
    if (@file_put_contents($tmp, $data) === false) {
        return false;
    }
    if (@rename($tmp, $path)) {
        return true;
    }
    @unlink($tmp);
    return false;
}

/**
 * Fetch one release file into $dest, following at most five redirects,
 * each checked against the allow-list. True only for a complete file.
 */
function nxg_fetch($platform, $url, $dest, $timeout)
{
    if (!function_exists('curl_init')) {
        return false;
    }
    $meta = nxg_platforms();
    $meta = $meta[$platform];
    $max = (int) nxg_cfg('installer_max_bytes', 200 * 1024 * 1024);
    $dir = dirname($dest);
    if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
        return false;
    }
    $tmp = $dir . '/.part-' . bin2hex(random_bytes(6));
    $deadline = time() + $timeout;
    $ok = false;

    for ($hop = 0; $hop < 6 && !$ok; $hop++) {
        if (!nxg_allowed_host($url) || time() >= $deadline) {
            break;
        }
        $fh = @fopen($tmp, 'wb');
        if (!$fh) {
            break;
        }
        $ch = nxg_curl($url, $deadline - time());
        curl_setopt($ch, CURLOPT_FILE, $fh);
        curl_setopt($ch, CURLOPT_MAXFILESIZE, $max);
        curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 20000);
        curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, 20);
        // Stop as soon as more than the cap arrives, Content-Length or not.
        curl_setopt($ch, CURLOPT_NOPROGRESS, false);
        curl_setopt($ch, CURLOPT_PROGRESSFUNCTION, function ($c, $dlTotal, $dlNow) use ($max) {
            return ($dlTotal > $max || $dlNow > $max) ? 1 : 0;
        });
        $done = curl_exec($ch) !== false;
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $next = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        $length = (int) curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
        curl_close($ch);
        fclose($fh);

        if ($done && $code >= 300 && $code <= 399 && $next !== '') {
            $url = $next;
            continue;
        }
        if (!$done || $code !== 200) {
            break;
        }
        clearstatcache(true, $tmp);
        $size = (int) @filesize($tmp);
        // Content-Length is required: without it a cut-off transfer looks
        // the same as a finished one.
        if ($length <= 0 || $size !== $length || $size > $max) {
            break;
        }
        $head = (string) @file_get_contents($tmp, false, null, 0, strlen($meta['magic']));
        if ($head !== $meta['magic']) {
            break;
        }
        @chmod($tmp, 0644);
        $ok = @rename($tmp, $dest);
    }
    if (is_file($tmp)) {
        @unlink($tmp);
    }
    return $ok;
}

/** Keep the two newest release folders for a platform; delete the rest and old partials. */
function nxg_prune($platformDir, $keepTag)
{
    $dirs = array();
    foreach ((array) @scandir($platformDir) as $name) {
        if ($name === '.' || $name === '..' || $name === '') {
            continue;
        }
        $path = $platformDir . '/' . $name;
        if (is_dir($path)) {
            $dirs[$name] = (int) @filemtime($path);
        }
    }
    arsort($dirs);
    $keep = array($keepTag);
    foreach (array_keys($dirs) as $name) {
        if (count($keep) >= 2) {
            break;
        }
        if ($name !== $keepTag) {
            $keep[] = $name;
        }
    }
    foreach (array_keys($dirs) as $name) {
        $path = $platformDir . '/' . $name;
        foreach ((array) @scandir($path) as $f) {
            if ($f === '.' || $f === '..' || $f === '') {
                continue;
            }
            $fp = $path . '/' . $f;
            $stale = strpos($f, '.part-') === 0 && (int) @filemtime($fp) < time() - 3600;
            if (!in_array($name, $keep, true) || $stale) {
                @unlink($fp);
            }
        }
        if (!in_array($name, $keep, true)) {
            @rmdir($path);
        }
    }
}

/**
 * Make sure the current release is on disk. Returns its public URL, or ''
 * to tell the caller to fall back.
 *
 * @param int  $budget  seconds for everything: asking, waiting and fetching
 * @param bool $verbose print what happens (command line)
 */
function nxg_ensure($platform, $upstream, $budget, $verbose)
{
    $end = time() + (int) $budget;
    $say = function ($m) use ($verbose, $platform) {
        if ($verbose) {
            echo $platform . ': ' . $m . "\n";
        }
    };
    if (!function_exists('curl_init')) {
        $say('no curl extension');
        return '';
    }
    $store = nxg_store();
    $state = nxg_state();
    if ($store === '' || $state === '') {
        $say('store or state folder missing or not writable');
        return '';
    }
    $ttl = (int) nxg_cfg('installer_resolve_ttl', 600);
    $ttl = $ttl > 600 ? 600 : ($ttl < 0 ? 0 : $ttl);
    $cacheFile = $state . '/' . $platform . '.php';
    $platformDir = $store . '/' . $platform;
    nxg_state_legacy($state, $platform);

    $cached = nxg_state_read($cacheFile);
    $known = is_array($cached) && isset($cached['at'], $cached['tag'], $cached['file'], $cached['url'], $cached['src'])
        && $cached['src'] === $upstream
        && nxg_safe_name($cached['tag']) === $cached['tag'] && nxg_safe_name($cached['file']) === $cached['file'];
    $fresh = $known && (time() - (int) $cached['at']) < $ttl;

    if ($fresh) {
        $rel = $cached;
        $say('release (remembered) ' . $rel['tag'] . '/' . $rel['file']);
    } else {
        $rel = nxg_resolve($platform, $upstream, $end - time());
        if ($rel === null) {
            // The endpoint is down or unreachable from here. The fallback is
            // that same address, so the last copy on disk is the better
            // answer. It may be one release old; the app updates itself.
            if ($known) {
                $last = $platformDir . '/' . $cached['tag'] . '/' . $cached['file'];
                if (is_file($last)) {
                    $say('the installer URL gave no usable release answer; serving the last copy, ' . $cached['tag']);
                    return nxg_public_url($platform, $cached['tag'], $cached['file']);
                }
            }
            $say('the installer URL gave no usable release answer');
            return '';
        }
        $rel['src'] = $upstream;
        $rel['at'] = time();
        nxg_write($cacheFile, NXG_GUARD . json_encode($rel));
        $say('release ' . $rel['tag'] . '/' . $rel['file']);
    }

    $dest = $platformDir . '/' . $rel['tag'] . '/' . $rel['file'];
    $url = nxg_public_url($platform, $rel['tag'], $rel['file']);
    if (is_file($dest)) {
        $say('already here, ' . filesize($dest) . ' bytes');
        return $url;
    }

    if (!is_dir($platformDir) && !@mkdir($platformDir, 0755, true)) {
        return '';
    }
    $lock = @fopen($state . '/' . $platform . '.lock.php', 'c');
    if (!$lock) {
        return '';
    }
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        // Someone else is fetching it. Wait for them, not for a second copy.
        $say('another fetch is running; waiting');
        while (time() < $end) {
            sleep(1);
            clearstatcache(true, $dest);
            if (is_file($dest)) {
                fclose($lock);
                return $url;
            }
            if (flock($lock, LOCK_EX | LOCK_NB)) {
                break; // they gave up; try ourselves below
            }
        }
        if (!is_file($dest) && !flock($lock, LOCK_EX | LOCK_NB)) {
            fclose($lock);
            return '';
        }
    }

    clearstatcache(true, $dest);
    $failFile = $state . '/' . $platform . '.failed.php';
    if (!is_file($dest) && is_file($failFile) && (time() - (int) @filemtime($failFile)) < 300) {
        // A fetch failed in the last five minutes: do not make every visitor
        // wait for the same failure. They get the fallback straight away.
        $say('a fetch failed less than five minutes ago; not retrying yet');
        flock($lock, LOCK_UN);
        fclose($lock);
        return '';
    }
    if (!is_file($dest)) {
        $free = @disk_free_space($store);
        $max = (int) nxg_cfg('installer_max_bytes', 200 * 1024 * 1024);
        if ($free !== false && $free < 2 * $max) {
            $say('not enough free disk');
            flock($lock, LOCK_UN);
            fclose($lock);
            return '';
        }
        if ($end - time() < 5) {
            // Too little of the budget left to be worth starting.
            $say('no time left for a fetch');
            flock($lock, LOCK_UN);
            fclose($lock);
            return '';
        }
        $t0 = microtime(true);
        $ok = nxg_fetch($platform, $rel['url'], $dest, $end - time());
        $say(($ok ? 'fetched ' . filesize($dest) . ' bytes' : 'fetch failed') . ' in ' . round(microtime(true) - $t0, 2) . ' s');
        if ($ok) {
            @unlink($failFile);
            nxg_prune($platformDir, $rel['tag']);
        } else {
            @touch($failFile);
        }
    }
    flock($lock, LOCK_UN);
    fclose($lock);
    return is_file($dest) ? $url : '';
}

// ---------------------------------------------------------------------
// Command line: php get/index.php warm [windows|android]
// ---------------------------------------------------------------------

if (PHP_SAPI === 'cli' && !isset($_SERVER['REQUEST_URI'])) {
    $args = isset($argv) ? array_slice($argv, 1) : array();
    if (!isset($args[0]) || $args[0] !== 'warm') {
        fwrite(STDERR, "usage: php get/index.php warm [windows|android]\n");
        exit(2);
    }
    $which = isset($args[1]) ? array($args[1]) : array_keys(nxg_platforms());
    $status = 0;
    foreach ($which as $p) {
        $all = nxg_platforms();
        if (!isset($all[$p])) {
            fwrite(STDERR, "unknown platform: $p\n");
            exit(2);
        }
        $up = trim((string) nxg_cfg($all[$p]['cfg'], ''));
        $u = $up === '' ? '' : nxg_ensure($p, $up, 900, true);
        echo $p . ': ' . ($u !== '' ? 'serving ' . $u : 'FALLBACK to the installer URL') . "\n";
        $status = $u !== '' ? $status : 1;
    }
    exit($status);
}

// ---------------------------------------------------------------------
// Web request
// ---------------------------------------------------------------------

require dirname(__DIR__) . '/inc/headers.php';
nx_security_headers();
header('Cache-Control: no-store');
header('X-Robots-Tag: noindex, nofollow');

$platform = isset($_GET['p']) && is_string($_GET['p']) ? $_GET['p'] : '';
$all = nxg_platforms();
$downloadPage = nxg_cfg('base_path', '/') . 'download/';
if (!isset($all[$platform])) {
    header('Location: ' . $downloadPage, true, 302);
    exit;
}
$upstream = trim((string) nxg_cfg($all[$platform]['cfg'], ''));
if ($upstream === '') {
    header('Location: ' . $downloadPage, true, 302);
    exit;
}

$target = $upstream;
if (nxg_cfg('installer_local_copy', false)) {
    ignore_user_abort(true);
    // One 45 s budget covers asking, waiting for another visitor's fetch
    // and fetching, under the host's 60 s gateway timeout, so the visitor
    // always gets an answer: a slower fetch is abandoned and this visitor
    // gets the fallback. ignore_user_abort keeps a visitor who closes the
    // tab from cutting a fetch short.
    @set_time_limit(120);
    $local = nxg_ensure($platform, $upstream, 45, false);
    if ($local !== '') {
        $target = $local;
    }
}

// 302, never 301: what "the current release" is changes with every release.
header('Location: ' . $target, true, 302);
exit;
