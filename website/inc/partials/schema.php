<?php
/**
 * JSON-LD structured data.
 *
 * Emitted as a single <script type="application/ld+json"> holding an
 * @graph, rather than several separate script blocks. One block means one
 * place for the @id cross-references below to resolve against, and it is
 * what Google's own documentation recommends when a page describes more
 * than one thing.
 *
 * A note on the Content-Security-Policy in .htaccess, which sets
 * script-src 'self' with no 'unsafe-inline': this block is safe under it.
 * A <script> whose type is not a JavaScript MIME type is never prepared
 * for execution, so it is a data block rather than a script block and CSP
 * does not apply to it. That is why strict-CSP sites ship JSON-LD inline
 * as a matter of routine. Do not "fix" the CSP on account of this file.
 *
 * ---------------------------------------------------------------------
 * WHAT THIS FILE WILL NOT SAY
 * ---------------------------------------------------------------------
 * Structured data is the easiest place on a website to tell a lie that
 * looks official, and the most likely to be believed, because it is read
 * by machines that then repeat it in search results. So:
 *
 *   - No aggregateRating and no review. There are no reviews. Inventing
 *     stars is the single most common structured-data fraud and Google
 *     has manual actions for exactly it.
 *   - No priceValidUntil, no shipping, no returns policy -- none of those
 *     are established facts about this service.
 *   - No foundingDate, no numberOfEmployees, no address. Not known.
 *   - SoftwareApplication entries only for platforms that genuinely ship
 *     (Windows, Android). macOS and iOS do not exist, so they get no
 *     entry, however much it would pad the graph out.
 *
 * If you add to this file, hold it to that bar: everything here must be
 * checkable against the product itself.
 */

defined('NX') || exit;

/**
 * Build the JSON-LD graph for the current page.
 *
 * @return array list of schema.org nodes
 */
function nx_schema_graph()
{
    $page = nx_page();
    $site = rtrim((string) nx_cfg('site_url', ''), '/');
    $locale = nx_locale();
    $lang = $locale === 'fa' ? 'fa-IR' : 'en';

    // Stable @id anchors. Fragment ids on the site root, which is the
    // conventional way to give an organisation a durable identifier that
    // does not move when a page is renamed.
    $orgId = $site . '/#organization';
    $siteId = $site . '/#website';

    $graph = array();

    // ---------------------------------------------------------------
    // Organization -- the publisher every other node points back to
    // ---------------------------------------------------------------

    $org = array(
        '@type' => 'Organization',
        '@id' => $orgId,
        'name' => nx_t('brand.name'),
        'url' => $site . '/',
        'logo' => array(
            '@type' => 'ImageObject',
            'url' => $site . nx_cfg('base_path', '/') . 'assets/img/logo-512.png',
            'width' => 512,
            'height' => 512,
        ),
        'description' => nx_t('schema.org.description'),
        'contactPoint' => array(array(
            '@type' => 'ContactPoint',
            'contactType' => 'customer support',
            'email' => (string) nx_cfg('contact_email', ''),
            'url' => nx_abs_url('contact'),
            // Both languages support is actually offered in. Claiming a
            // third would be trivially disprovable by writing in it.
            'availableLanguage' => array('en', 'fa'),
        )),
    );

    // sameAs only when a profile genuinely exists. An empty sameAs array is
    // worse than none -- it is a claim to have social presence and no proof.
    $sameAs = array();
    $telegram = trim((string) nx_cfg('telegram_url', ''));
    if ($telegram !== '') {
        $sameAs[] = $telegram;
    }
    if ($sameAs) {
        $org['sameAs'] = $sameAs;
    }

    $graph[] = $org;

    // ---------------------------------------------------------------
    // WebSite
    // ---------------------------------------------------------------

    $graph[] = array(
        '@type' => 'WebSite',
        '@id' => $siteId,
        'url' => $site . '/',
        'name' => nx_t('brand.name'),
        'publisher' => array('@id' => $orgId),
        'inLanguage' => $lang,
        // No SearchAction: the site has no search. Declaring a sitelinks
        // search box that does not exist is a broken promise Google will
        // try to render.
    );

    // ---------------------------------------------------------------
    // WebPage for this page
    // ---------------------------------------------------------------

    $graph[] = array(
        '@type' => 'WebPage',
        '@id' => nx_abs_url($page) . '#webpage',
        'url' => nx_abs_url($page),
        'name' => nx_t('meta.' . $page . '.title'),
        'description' => nx_t('meta.' . $page . '.description'),
        'isPartOf' => array('@id' => $siteId),
        'inLanguage' => $lang,
    );

    // ---------------------------------------------------------------
    // BreadcrumbList -- every page except the home page
    // ---------------------------------------------------------------

    if ($page !== 'home') {
        // The crumb label prefers the short navigation word ("Download")
        // over the full page title ("Download — Neoxify"), which is what a
        // breadcrumb should read like. But not every page has a nav entry:
        // delete-account is deliberately unlinked, so nx_t('nav.delete-account')
        // returned the literal ⟪nav.delete-account⟫ and put it straight into
        // the structured data -- caught by the string check below, having
        // been introduced by this very function.
        //
        // nx_has() rather than a try/catch on the ⟪⟫ marker: testing for the
        // marker would treat a legitimate string containing those characters
        // as missing.
        $crumb = nx_has('nav.' . $page)
            ? nx_t('nav.' . $page)
            : nx_t('meta.' . $page . '.title');

        $graph[] = array(
            '@type' => 'BreadcrumbList',
            '@id' => nx_abs_url($page) . '#breadcrumb',
            'itemListElement' => array(
                array(
                    '@type' => 'ListItem',
                    'position' => 1,
                    'name' => nx_t('nav.home'),
                    'item' => nx_abs_url('home'),
                ),
                array(
                    '@type' => 'ListItem',
                    'position' => 2,
                    'name' => $crumb,
                    'item' => nx_abs_url($page),
                ),
            ),
        );
    }

    // ---------------------------------------------------------------
    // Product + Offers -- the plans
    // ---------------------------------------------------------------

    if ($page === 'pricing' || $page === 'home') {
        $plans = nx_content('plans');
        $currency = 'USD';
        $offers = array();

        foreach (isset($plans['plans']) ? $plans['plans'] : array() as $plan) {
            // A plan that cannot be bought is not an Offer. Listing it as
            // InStock would be false, and listing it as PreOrder invites
            // Google to render a buy button for something with no
            // checkout behind it.
            if (!empty($plan['coming_soon'])) {
                continue;
            }

            $offers[] = array(
                '@type' => 'Offer',
                'name' => nx_pick($plan['name']),
                'price' => number_format((float) $plan['price'], 2, '.', ''),
                'priceCurrency' => $currency,
                'url' => nx_abs_url('pricing'),
                'availability' => 'https://schema.org/InStock',
                // The billing period, stated in the machine-readable form
                // rather than left for a parser to guess from the name.
                'priceSpecification' => array(
                    '@type' => 'UnitPriceSpecification',
                    'price' => number_format((float) $plan['price'], 2, '.', ''),
                    'priceCurrency' => $currency,
                    'billingDuration' => (int) $plan['duration_days'],
                    'billingIncrement' => 1,
                    'unitCode' => 'DAY',
                ),
            );
        }

        if ($offers) {
            $graph[] = array(
                '@type' => 'Product',
                '@id' => $site . '/#product',
                'name' => nx_t('brand.name'),
                'description' => nx_t('schema.product.description'),
                'brand' => array('@id' => $orgId),
                'category' => 'VPN service',
                'offers' => $offers,
            );
        }
    }

    // ---------------------------------------------------------------
    // FAQPage
    // ---------------------------------------------------------------

    if ($page === 'faq') {
        $entries = array();

        foreach (nx_visible_faq() as $item) {
            $entries[] = array(
                '@type' => 'Question',
                'name' => nx_pick($item['q']),
                'acceptedAnswer' => array(
                    '@type' => 'Answer',
                    'text' => nx_pick($item['a']),
                ),
            );
        }

        if ($entries) {
            $graph[] = array(
                '@type' => 'FAQPage',
                '@id' => nx_abs_url('faq') . '#faq',
                'inLanguage' => $lang,
                'mainEntity' => $entries,
            );
        }
    }

    // ---------------------------------------------------------------
    // SoftwareApplication -- only for clients that actually exist
    // ---------------------------------------------------------------

    if ($page === 'download' || $page === 'home') {
        $apps = array();

        if (nx_windows_available()) {
            $apps[] = array(
                '@type' => 'SoftwareApplication',
                '@id' => $site . '/#app-windows',
                'name' => nx_t('schema.app.windows.name'),
                'operatingSystem' => 'Windows 10, Windows 11',
                'applicationCategory' => 'SecurityApplication',
                'downloadUrl' => nx_abs_url('download'),
                'softwareRequirements' => nx_t('download.windows.requirements'),
                'publisher' => array('@id' => $orgId),
                // No version number, on purpose and for the same reason the
                // download page carries none: the URL always resolves to the
                // current release, and a number here could only go stale.
                'offers' => nx_free_trial_enabled() ? array(
                    '@type' => 'Offer',
                    'price' => '0',
                    'priceCurrency' => 'USD',
                    'description' => nx_t('schema.app.trial'),
                ) : null,
            );
        }

        if (nx_android_available()) {
            $apps[] = array(
                '@type' => 'SoftwareApplication',
                '@id' => $site . '/#app-android',
                'name' => nx_t('schema.app.android.name'),
                'operatingSystem' => 'Android 7.0+',
                'applicationCategory' => 'SecurityApplication',
                'downloadUrl' => nx_abs_url('download'),
                'softwareRequirements' => nx_t('download.android.requirements'),
                'publisher' => array('@id' => $orgId),
                'offers' => nx_free_trial_enabled() ? array(
                    '@type' => 'Offer',
                    'price' => '0',
                    'priceCurrency' => 'USD',
                    'description' => nx_t('schema.app.trial'),
                ) : null,
            );
        }

        foreach ($apps as $app) {
            // Strip the null offers rather than emitting "offers": null,
            // which is not valid and makes the whole node suspect.
            $graph[] = array_filter($app, function ($v) {
                return $v !== null;
            });
        }
    }

    return $graph;
}

/**
 * Print the JSON-LD block.
 *
 * JSON_UNESCAPED_UNICODE keeps the Persian readable rather than emitting a
 * wall of \u escapes -- both are valid, but one of them can be checked by a
 * human. JSON_UNESCAPED_SLASHES for the same reason on URLs.
 *
 * The </script> guard matters: a translated string containing that sequence
 * would otherwise close the block early and dump the rest of the graph into
 * the page as text. HEX_TAG encodes < and > so it cannot happen.
 */
function nx_render_schema()
{
    $graph = nx_schema_graph();
    if (!$graph) {
        return;
    }

    $doc = array(
        '@context' => 'https://schema.org',
        '@graph' => $graph,
    );

    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG;
    // PHP 7.4 has no JSON_THROW_ON_ERROR guarantee in every build here, so
    // check the return value rather than assuming.
    $json = json_encode($doc, $flags);
    if ($json === false) {
        return;
    }

    echo '<script type="application/ld+json">' . $json . '</script>' . "\n";
}
