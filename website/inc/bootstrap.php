<?php
/**
 * Shared bootstrap: configuration, locale resolution, translation and URL
 * helpers. Every page includes this first and nothing else works without it.
 *
 * A page sets two variables before including this file:
 *
 *     $NX_LOCALE = 'en';      // 'en' or 'fa'
 *     $NX_PAGE   = 'home';    // home | download | contact | reseller
 *     require __DIR__ . '/inc/bootstrap.php';
 *
 * PHP 7.4 compatible: no match(), no nullsafe operators, no str_contains(),
 * no constructor promotion. The shared host decides the PHP version, not us.
 */

// Marks "we were reached through a real page". Every include checks this so
// that requesting inc/anything.php directly just exits silently.
define('NX', 1);

define('NX_INC', __DIR__);
define('NX_ROOT', dirname(__DIR__));
define('NX_DATA', NX_ROOT . '/data');

$NX_CFG = require NX_INC . '/config.php';

/** Locales the site is actually translated into, and which of them are RTL. */
$NX_LOCALES = array('en', 'fa');
$NX_RTL_LOCALES = array('fa');

/** page key => URL segment, relative to the locale root. */
$NX_ROUTES = array(
    'home'     => '',
    'download' => 'download/',
    'contact'  => 'contact/',
    'reseller' => 'reseller/',
    'privacy'  => 'privacy/',
);

// Fall back rather than fatal, so a page that forgets to declare itself still
// renders something sane instead of a blank white screen on the live host.
if (!isset($NX_LOCALE) || !in_array($NX_LOCALE, $NX_LOCALES, true)) {
    $NX_LOCALE = 'en';
}
if (!isset($NX_PAGE) || !isset($NX_ROUTES[$NX_PAGE])) {
    $NX_PAGE = 'home';
}

// English is always loaded first so that a key missing from a translation
// falls back to real English text rather than showing a raw key to a visitor.
$NX_LANG_EN = require NX_INC . '/lang/en.php';
$NX_LANG = $NX_LOCALE === 'en'
    ? $NX_LANG_EN
    : array_merge($NX_LANG_EN, require NX_INC . '/lang/' . $NX_LOCALE . '.php');


// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

/**
 * Read a configuration value.
 *
 * @param string $key
 * @param mixed  $default
 * @return mixed
 */
function nx_cfg($key, $default = null)
{
    global $NX_CFG;
    return isset($NX_CFG[$key]) ? $NX_CFG[$key] : $default;
}


// ---------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------

/** @return string current locale code */
function nx_locale()
{
    global $NX_LOCALE;
    return $NX_LOCALE;
}

/** @return string current page key */
function nx_page()
{
    global $NX_PAGE;
    return $NX_PAGE;
}

/** @return bool whether the current locale reads right-to-left */
function nx_is_rtl()
{
    global $NX_RTL_LOCALES;
    return in_array(nx_locale(), $NX_RTL_LOCALES, true);
}

/** @return string 'rtl' or 'ltr', for the <html dir> attribute */
function nx_dir()
{
    return nx_is_rtl() ? 'rtl' : 'ltr';
}

/** @return string the locale a visitor would switch to from here */
function nx_other_locale()
{
    return nx_locale() === 'en' ? 'fa' : 'en';
}


// ---------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------

/**
 * Translate a string key.
 *
 * Missing keys render as ⟪key⟫ rather than an empty string -- a visible gap
 * during development is far better than silently shipping a blank heading.
 *
 * @param string $key
 * @param array  $vars  :name placeholders to substitute
 * @return string
 */
function nx_t($key, $vars = array())
{
    global $NX_LANG;

    if (!isset($NX_LANG[$key]) || !is_string($NX_LANG[$key])) {
        return '⟪' . $key . '⟫';
    }

    $text = $NX_LANG[$key];
    foreach ($vars as $name => $value) {
        $text = str_replace(':' . $name, (string) $value, $text);
    }
    return $text;
}

/**
 * Translate a key whose value is a list (feature bullets, steps, and so on).
 *
 * @param string $key
 * @return array
 */
function nx_ta($key)
{
    global $NX_LANG;
    return (isset($NX_LANG[$key]) && is_array($NX_LANG[$key])) ? $NX_LANG[$key] : array();
}

/** Translate and HTML-escape in one step -- the common case in templates. */
function nx_e($key, $vars = array())
{
    return nx_esc(nx_t($key, $vars));
}


// ---------------------------------------------------------------------
// Escaping and URLs
// ---------------------------------------------------------------------

/**
 * HTML-escape a value for output. ENT_SUBSTITUTE keeps malformed UTF-8 from
 * blanking the whole string, which matters when we echo user-submitted text
 * back into a form after a validation error.
 *
 * @param string|null $value
 * @return string
 */
function nx_esc($value)
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * Build a URL for one of the site's pages.
 *
 * @param string      $page   page key
 * @param string|null $locale defaults to the current locale
 * @return string
 */
function nx_url($page = 'home', $locale = null)
{
    global $NX_ROUTES;

    $locale = $locale === null ? nx_locale() : $locale;
    $base = nx_cfg('base_path', '/');
    $prefix = $locale === 'en' ? '' : $locale . '/';
    $segment = isset($NX_ROUTES[$page]) ? $NX_ROUTES[$page] : '';

    return $base . $prefix . $segment;
}

/** Absolute URL for the same page, used for canonical/OG/sitemap tags. */
function nx_abs_url($page = 'home', $locale = null)
{
    return rtrim(nx_cfg('site_url', ''), '/') . nx_url($page, $locale);
}

/**
 * URL for a static asset, with a cache-busting stamp derived from the file's
 * own mtime -- so a redeploy can never leave a visitor on a stale stylesheet,
 * and we don't have to remember to bump a version by hand.
 *
 * @param string $relative path under assets/, e.g. 'css/site.css'
 * @return string
 */
function nx_asset($relative)
{
    $url = nx_cfg('base_path', '/') . 'assets/' . ltrim($relative, '/');
    $file = NX_ROOT . '/assets/' . ltrim($relative, '/');

    if (is_file($file)) {
        $url .= '?v=' . filemtime($file);
    }
    return $url;
}



// ---------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------

/**
 * Whether there is a Windows installer to link to.
 *
 * Config decides, rather than the page assuming: with no URL set the download
 * page says the app is not out yet instead of offering a dead button.
 *
 * @return bool
 */
function nx_windows_available()
{
    return nx_windows_download_url() !== '';
}

/**
 * Download URL for the Windows installer, or '' if unreleased.
 *
 * A single configured URL that always resolves to the current release -- the
 * site deliberately holds no version number or release tag of its own, since
 * that is exactly what silently went stale and served an old build. See the
 * note in config.php.
 */
function nx_windows_download_url()
{
    return trim((string) nx_cfg('windows_installer_url', ''));
}

/**
 * Whether there is an Android build to link to.
 *
 * Separate from Windows rather than one "is the app out" flag: the two
 * ship on their own schedules, and a page that hides Android because
 * Windows is unset would be wrong in a way nobody would notice.
 *
 * @return bool
 */
function nx_android_available()
{
    return nx_android_download_url() !== '';
}

/** Download URL for the Android APK, or '' if unreleased. */
function nx_android_download_url()
{
    return trim((string) nx_cfg('android_installer_url', ''));
}

/** URL of published checksums, or '' when none is configured. */
function nx_windows_checksum_url()
{
    return trim((string) nx_cfg('windows_checksums_url', ''));
}

/** Whether to show the beta badge and explanation. */
function nx_beta()
{
    return (bool) nx_cfg('beta_enabled', false);
}


// ---------------------------------------------------------------------
// Content files
// ---------------------------------------------------------------------

/**
 * Load a file from inc/content/, once per request.
 *
 * @param string $name 'plans' or 'faq'
 * @return array
 */
function nx_content($name)
{
    static $loaded = array();

    if (!isset($loaded[$name])) {
        $file = NX_INC . '/content/' . basename($name) . '.php';
        $loaded[$name] = is_file($file) ? require $file : array();
    }
    return $loaded[$name];
}

/**
 * Pick the current locale's variant out of a per-locale value.
 *
 * Content files store strings as array('en' => ..., 'fa' => ...) so that
 * adding a plan or a question is a one-file edit. Falls back to English, then
 * to whatever is there, so a half-translated entry still renders.
 *
 * @param array|string $value
 * @param string|null  $locale
 * @return string
 */
function nx_pick($value, $locale = null)
{
    if (!is_array($value)) {
        return (string) $value;
    }

    $locale = $locale === null ? nx_locale() : $locale;

    if (isset($value[$locale])) {
        return (string) $value[$locale];
    }
    if (isset($value['en'])) {
        return (string) $value['en'];
    }
    return $value ? (string) reset($value) : '';
}

/**
 * Pick a per-locale LIST out of a content entry -- the paragraph and bullet
 * arrays in inc/content/privacy.php, where nx_pick() would return an array
 * where a string is expected.
 *
 * @param array       $item   the content entry
 * @param string      $key    'body', 'bullets', ...
 * @param string|null $locale defaults to the current locale
 * @return array empty when the key or the locale's list is absent
 */
function nx_pick_list($item, $key, $locale = null)
{
    if (!isset($item[$key]) || !is_array($item[$key])) {
        return array();
    }

    $set = $item[$key];
    $locale = $locale === null ? nx_locale() : $locale;

    if (isset($set[$locale]) && is_array($set[$locale])) {
        return $set[$locale];
    }
    if (isset($set['en']) && is_array($set['en'])) {
        return $set['en'];
    }
    return array();
}

/** Whether the site should advertise the free trial. */
function nx_free_trial_enabled()
{
    return (bool) nx_cfg('free_trial_enabled', false);
}

/** Whether the site should advertise the referral programme. */
function nx_referrals_enabled()
{
    return (bool) nx_cfg('referrals_enabled', false);
}

/**
 * Render a data allowance. Whole multiples of 1024 GB read better as TB.
 *
 * @param int $gb
 * @return string
 */
function nx_format_data($gb)
{
    $gb = (int) $gb;
    if ($gb >= 1024 && $gb % 1024 === 0) {
        return ($gb / 1024) . ' TB';
    }
    return $gb . ' GB';
}

/**
 * Render a price. Trailing '.00' is dropped so a round number doesn't read
 * like a rounding artefact.
 *
 * @param float $amount
 * @return string
 */
function nx_price($amount)
{
    $plans = nx_content('plans');
    $symbol = isset($plans['currency_symbol']) ? $plans['currency_symbol'] : '$';

    $formatted = number_format((float) $amount, 2, '.', ',');
    if (substr($formatted, -3) === '.00') {
        $formatted = substr($formatted, 0, -3);
    }
    return $symbol . $formatted;
}


// ---------------------------------------------------------------------
// Locale preference and automatic language
// ---------------------------------------------------------------------
//
// Last, because it needs nx_url() and nx_page() above, and it must still run
// before a single byte of output -- it may redirect.
//
// A page can opt out by setting $NX_SKIP_LOCALE_REDIRECT before including
// this file. The sitemap and the 404 page both do: neither is a page a
// visitor chose to read in a particular language, and redirecting them would
// be noise at best and a crawl problem at worst.

require_once NX_INC . '/locale.php';

if (empty($NX_SKIP_LOCALE_REDIRECT)) {
    nx_apply_locale_preference();
}
