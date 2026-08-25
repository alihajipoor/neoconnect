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
    // Three pages split out of the home page in the 2026-08 rebuild.
    // Pricing and the FAQ used to exist only as #anchors on the home page,
    // which meant neither could carry its own title, description, canonical
    // or structured data -- and "neoxify pricing" had no page to rank. The
    // home page still has a pricing summary and links here for the detail.
    'features' => 'features/',
    'pricing'  => 'pricing/',
    'faq'      => 'faq/',
    'download' => 'download/',
    'contact'  => 'contact/',
    'reseller' => 'reseller/',
    'privacy'  => 'privacy/',
    // Not linked from the navigation on purpose -- it is reached from the
    // Play listing's data safety declaration and from the app, not browsed
    // to. It still has to be registered here: an unregistered key falls
    // back to 'home' below, which would leave the page rendering with the
    // wrong canonical URL and a language switcher pointing at the
    // homepage.
    'delete-account' => 'delete-account/',
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
 * Whether a translation key exists as a real string.
 *
 * nx_t() renders a missing key as ⟪key⟫, which is the right behaviour for a
 * template -- a visible gap beats a silent blank. It is the wrong behaviour
 * for code that wants to CHOOSE between two keys, because every key then
 * looks present. This is that test.
 *
 * @param string $key
 * @return bool
 */
function nx_has($key)
{
    global $NX_LANG;
    return isset($NX_LANG[$key]) && is_string($NX_LANG[$key]);
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
 * Pick a per-locale value and HTML-escape it in one step.
 *
 * The content-file counterpart to nx_e(), and the common case in templates
 * that render inc/content/*.php. Having it means a template never writes
 * nx_pick() bare into the document, which is the shape an unescaped echo
 * takes when someone is in a hurry.
 *
 * @param mixed       $value  per-locale array, or a plain string
 * @param string|null $locale defaults to the current locale
 * @return string
 */
function nx_e_pick($value, $locale = null)
{
    return nx_esc(nx_pick($value, $locale));
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

/**
 * The FAQ entries that may actually be shown.
 *
 * inc/content/faq.php lets an entry declare `requires` => 'free_trial' or
 * 'referrals', so the site stays quiet about a feature whose panel switch is
 * off. That filter used to live inline in the home page template, which was
 * fine while the FAQ appeared in exactly one place. It now appears in three
 * -- the home page, the FAQ page, and the FAQPage structured data -- and a
 * filter copied three times is a filter that will eventually disagree with
 * itself and put a claim in the JSON-LD that is not on the page.
 *
 * An unknown requirement hides the entry. Failing closed is the safe
 * direction when the claim might not be true.
 *
 * @return array
 */
function nx_visible_faq()
{
    $switches = array(
        'free_trial' => nx_free_trial_enabled(),
        'referrals'  => nx_referrals_enabled(),
    );

    $out = array();
    foreach (nx_content('faq') as $item) {
        if (isset($item['requires']) && empty($switches[$item['requires']])) {
            continue;
        }
        $out[] = $item;
    }
    return $out;
}


// ---------------------------------------------------------------------
// Fleet and protocols
// ---------------------------------------------------------------------

/**
 * The direct server locations, as rows ready to render.
 *
 * Reads inc/content/locations.php. Returns an empty list if that file is
 * emptied, and every caller checks -- so removing the fleet claim from the
 * site is a one-file edit rather than a hunt through templates.
 *
 * @return array
 */
function nx_locations()
{
    $data = nx_content('locations');
    return isset($data['direct']) && is_array($data['direct']) ? $data['direct'] : array();
}

/**
 * The Iran relay entry, or null when none is configured.
 *
 * Separate from the list above because it is not a place traffic comes out
 * of -- it is the way in. Rendering it as a sixth location would be a
 * quietly false claim about where a customer appears to be.
 *
 * @return array|null
 */
function nx_relay_location()
{
    $data = nx_content('locations');
    return (isset($data['relay']) && is_array($data['relay'])) ? $data['relay'] : null;
}

/** @return int how many direct locations there are, for copy that counts them */
function nx_location_count()
{
    return count(nx_locations());
}

/**
 * The connection methods, as rows ready to render.
 *
 * @return array
 */
function nx_protocols()
{
    $data = nx_content('protocols');
    return is_array($data) ? $data : array();
}

/**
 * Turn a two-letter country code into its flag emoji.
 *
 * Regional indicator symbols: 'f' + 'i' becomes U+1F1EB U+1F1EE, which every
 * modern platform renders as the Finnish flag. Built from the code rather
 * than pasted into the content file so a new location cannot arrive with a
 * mismatched flag, and so the data file stays readable in an editor that
 * does not render emoji.
 *
 * Windows renders these as two letters in a box rather than a flag -- it has
 * shipped no flag glyphs since Windows 8, deliberately. That is fine: "FI"
 * beside "Finland" is still perfectly legible, which is exactly why the
 * country name is never conveyed by the flag alone.
 *
 * @param string $code ISO 3166-1 alpha-2, any case
 * @return string
 */
function nx_flag($code)
{
    $code = strtoupper(trim((string) $code));
    if (!preg_match('/^[A-Z]{2}$/', $code)) {
        return '';
    }

    $out = '';
    for ($i = 0; $i < 2; $i++) {
        // 0x1F1E6 is REGIONAL INDICATOR SYMBOL LETTER A.
        $cp = 0x1F1E6 + (ord($code[$i]) - ord('A'));
        // mb_chr() is not guaranteed on shared hosting without mbstring, so
        // the code point is encoded by hand. Every value here is in the
        // 4-byte UTF-8 range, so no branching is needed.
        $out .= chr(0xF0 | ($cp >> 18))
            . chr(0x80 | (($cp >> 12) & 0x3F))
            . chr(0x80 | (($cp >> 6) & 0x3F))
            . chr(0x80 | ($cp & 0x3F));
    }
    return $out;
}

/** @return int how many connection methods are advertised */
function nx_protocol_count()
{
    return count(nx_protocols());
}

/**
 * Render a location as "City, Country" -- or just the country where the
 * repo does not record a city.
 *
 * Built here rather than in a template because three of the five locations
 * have no city and the fallback would otherwise be repeated at every call
 * site, which is how "Frankfurt, " with a trailing comma gets shipped.
 *
 * @param array $loc
 * @return string
 */
function nx_location_name($loc)
{
    $country = isset($loc['country']) ? nx_pick($loc['country']) : '';
    $city = isset($loc['city']) && $loc['city'] !== null ? nx_pick($loc['city']) : '';

    if ($city === '' || $city === $country) {
        return $country;
    }
    return nx_t('locations.city_country', array('city' => $city, 'country' => $country));
}


// ---------------------------------------------------------------------
// Customer area
// ---------------------------------------------------------------------

/**
 * The customer area's URL, or '' when it is switched off.
 *
 * @return string
 */
function nx_portal_url()
{
    return trim((string) nx_cfg('customer_portal_url', ''));
}

/** @return bool whether there is a customer area to link to at all */
function nx_portal_available()
{
    return nx_portal_url() !== '';
}

/**
 * Where a "Get this plan" button should go.
 *
 * The pricing cards used to point at the download page, because for a
 * long time there was nowhere to actually buy anything -- the app was
 * the only place an account could exist. That is no longer true, and a
 * pricing button that answers "how do I buy this?" with "here is an
 * installer" loses the sale at the exact moment someone decided to pay.
 *
 * The plan id rides along, but be clear about what it does today: the
 * portal uses it only to open ON the plans screen instead of the
 * account page. It does NOT yet preselect that specific plan, because
 * the API keys plans by uuid while this file keys them by a slug, and
 * matching them on the display name is a guess this is not willing to
 * make silently. Carried anyway so the link is already right when
 * preselection is built.
 *
 * Falls back to the download page when the portal is switched off, so
 * blanking customer_portal_url restores exactly the old behaviour
 * rather than rendering dead buttons.
 *
 * @param string $planId  the content file's plan key
 * @return string
 */
function nx_buy_url($planId = '')
{
    if (!nx_portal_available()) {
        return nx_url('download');
    }

    $url = nx_portal_url();
    $planId = trim((string) $planId);
    if ($planId === '') {
        return $url;
    }

    return $url . (strpos($url, '?') === false ? '?' : '&') . 'plan=' . rawurlencode($planId);
}


/**
 * Render a number in the current locale's own digits.
 *
 * Every hand-written Persian string on this site uses Persian digits
 * (۸۴, ۲۴), so a number substituted into one through :count arrived as a
 * Latin numeral and produced a mixed-script line -- "تا 2 دستگاه" beside
 * "۸۴ گیگابایت". Small, and exactly the sort of thing that reads as
 * carelessness to the audience it is aimed at.
 *
 * Deliberately NOT applied to prices. Those are US dollars, are quoted
 * that way everywhere including the payment pages, and a price in
 * Persian digits that does not match the checkout screen would be a real
 * confusion rather than a nicety.
 *
 * @param int|string $value
 * @return string
 */
function nx_num($value)
{
    $value = (string) $value;
    if (nx_locale() !== 'fa') {
        return $value;
    }
    return str_replace(
        array('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'),
        array('۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'),
        $value
    );
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
 * The unit is a translated word and the number goes through nx_num(),
 * because "30 GB" dropped into a Persian sentence does not survive the
 * bidirectional algorithm: the digits are neutral, the Latin unit is
 * left-to-right, and the run gets reordered so the plan card rendered
 * "GB 30" -- read right to left, the unit arrives before the amount. It
 * was on the Persian home page, the Persian pricing cards and the Persian
 * comparison table. Persian digits and a Persian unit have no direction
 * to disagree about, and they match every other number on those pages.
 *
 * @param int $gb
 * @return string
 */
function nx_format_data($gb)
{
    $gb = (int) $gb;
    if ($gb >= 1024 && $gb % 1024 === 0) {
        return nx_num($gb / 1024) . ' ' . nx_t('unit.tb');
    }
    return nx_num($gb) . ' ' . nx_t('unit.gb');
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
