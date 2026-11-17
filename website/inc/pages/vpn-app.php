<?php
/**
 * /vpn-app/ -- the landing page for the Google ads campaign (2026-11-16).
 *
 * WHY IT EXISTS. The campaign runs in English in the United States and the
 * EU. Its ad was disapproved under "Enabling dishonest behavior", because
 * Google judges the landing page too, and the home page speaks to the
 * service's core customers. This page speaks to the campaign's audience:
 * people who want their connection private on everyday networks and an app
 * that is simple. The home page is unchanged.
 *
 * Built from the home page's own sections and classes (home.css is inlined
 * for it, see head.php), so it looks like the same site.
 *
 * RULES FOR THIS PAGE, checked by scripts/check-site.php:
 *   - English only. noindex, no canonical, no structured data, no social
 *     card (the site's card carries the home page's message). Not in the
 *     navigation or the sitemap. /fa/vpn-app/ redirects to /fa/.
 *   - Nothing about restricted or filtered networks or countries, getting
 *     past them, being hard to block or detect, looking like other traffic,
 *     where you appear to be, unblocking or streaming; no "anonymous",
 *     "untraceable", "no logs", "fastest", ping or latency; no protocol,
 *     port or server host name. Every claim is one en.php already makes.
 *   - The calls to action are the home page's: /download/ and /pricing/.
 *     The ads tag's download event fires on /download/ as for any visit.
 *   - A PHONE goes straight to its store from the first and the last button
 *     (2026-11-17). Most of the campaign's clicks come from Android phones,
 *     and measured from the server log two in three left within ten
 *     seconds, with the download page still a second step away. The ads tag
 *     counts a store link as a download wherever it is (ads.js matches the
 *     address), so nothing else changes. The button under the list of
 *     devices keeps /download/ for everyone, which is how a phone still
 *     reaches the other downloads. A desktop, an iPad that says it is a
 *     Mac, and anything unrecognised keep /download/ everywhere.
 */

defined('NX') || exit;

$NX_NOINDEX = true;
$NX_OG_IMAGE = false;
$NX_ONE_LOCALE = true;

$nx_has_windows = nx_windows_available();

// Where the first and the last button lead, and what they say. '' for the
// label means "the page's usual wording".
$nx_cta_url = nx_url('download');
$nx_cta_label = '';
$nx_ua = strtolower(isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : '');
if (strpos($nx_ua, 'android') !== false && nx_android_play_url() !== '') {
    $nx_cta_url = nx_android_play_url();
    $nx_cta_label = 'download.android.play';
} elseif (preg_match('/iphone|ipad|ipod/', $nx_ua) && nx_ios_available()) {
    $nx_cta_url = nx_ios_store_url();
    $nx_cta_label = 'download.ios.button';
}
$nx_cta_rel = $nx_cta_label !== '' ? ' rel="noopener"' : '';
$nx_trial_days = nx_num((int) nx_cfg('free_trial_days', 7));
$nx_trial_data = nx_format_data(nx_cfg('free_trial_gb', 10));

$nx_shot = function ($variant) {
    $set = array();
    foreach (array(300, 450, 600) as $w) {
        $set[] = nx_asset('img/app/connected-' . $variant . '-' . $w . '.webp') . ' ' . $w . 'w';
    }
    return array('src' => nx_asset('img/app/connected-' . $variant . '-450.webp'), 'srcset' => implode(', ', $set));
};

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="hero">
  <?php echo nx_world('hero'); ?>
  <div class="wrap hero__inner">
    <?php require NX_INC . '/partials/announcement.php'; ?>

    <div class="hero__mark" aria-hidden="true">
      <span class="orbit"></span>
      <span class="orbit orbit--2"></span>
      <?php echo nx_logo('hero__logo'); ?>
    </div>

    <h1 class="hero__title">
      <span class="kicker"><?php echo nx_e('vpnapp.hero.kicker'); ?></span>
      <span class="tagline">
        <span><?php echo nx_e('vpnapp.hero.title_1'); ?></span>
        <span class="grad"><?php echo nx_e('vpnapp.hero.title_2'); ?></span>
      </span>
    </h1>

    <p class="lede"><?php echo nx_e('vpnapp.hero.subtitle'); ?></p>

    <div class="hero__actions">
      <a class="btn btn--primary btn--lg btn--magnet" href="<?php echo nx_esc($nx_cta_url); ?>"<?php echo $nx_cta_rel; ?>>
        <span><?php echo $nx_cta_label !== ''
            ? nx_e($nx_cta_label)
            : ($nx_has_windows
                ? nx_e('home.hero.cta_primary')
                : nx_e('home.hero.cta_primary_soon')); ?></span>
        <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
      <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.hero.cta_secondary'); ?></a>
    </div>

    <div class="chips">
      <?php if (nx_free_trial_enabled()): ?>
        <span class="chip"><span class="dot" aria-hidden="true"></span><?php echo nx_e('vpnapp.hero.chip_trial', array('days' => $nx_trial_days)); ?></span>
      <?php endif; ?>
      <span class="chip"><span class="dot" aria-hidden="true"></span><?php echo nx_e('vpnapp.hero.chip_apps'); ?></span>
      <span class="chip"><span class="dot" aria-hidden="true"></span><?php echo nx_e('home.hero.chip_locations'); ?></span>
    </div>

    <p class="hero__note">
      <?php echo nx_icon('info'); ?>
      <span><?php echo $nx_has_windows
          ? nx_e('home.hero.note_available')
          : nx_e('home.hero.note_soon'); ?></span>
    </p>
  </div>
</section>

<!-- ============================ The app ========================= -->
<section class="section showcase" aria-labelledby="h-app">
  <div class="wrap showcase__inner">
    <div class="showcase__copy reveal">
      <span class="eyebrow"><?php echo nx_e('home.app.eyebrow'); ?></span>
      <h2 class="h2" id="h-app"><?php echo nx_e('vpnapp.app.title'); ?></h2>
      <p class="lede"><?php echo nx_e('vpnapp.app.body'); ?></p>
      <ul class="checklist">
        <?php foreach (array('home.trust.state.title', 'home.config.point2', 'vpnapp.app.point_first') as $nx_pt): ?>
          <li><?php echo nx_icon('check'); ?><span><?php echo nx_e($nx_pt); ?></span></li>
        <?php endforeach; ?>
      </ul>
    </div>

    <figure class="showcase__stage">
      <div class="showcase__scene">
        <span class="showcase__glow" aria-hidden="true"></span>
        <span class="orbit orbit--stage" aria-hidden="true"></span>
        <div class="phone">
          <?php foreach (array('light', 'dark') as $nx_v): $nx_img = $nx_shot($nx_v); ?>
            <img class="phone__shot only-<?php echo $nx_v; ?>" src="<?php echo nx_esc($nx_img['src']); ?>"
                 srcset="<?php echo nx_esc($nx_img['srcset']); ?>" sizes="(max-width: 600px) 232px, 282px"
                 width="1080" height="1920" loading="lazy" decoding="async"
                 alt="<?php echo nx_e($nx_v === 'dark' ? 'vpnapp.app.alt_dark' : 'vpnapp.app.alt'); ?>">
          <?php endforeach; ?>
        </div>
        <?php for ($nx_n = 1; $nx_n <= 4; $nx_n++): ?>
          <span class="floater floater--<?php echo $nx_n; ?>" aria-hidden="true">
            <span class="floater__dot"></span>
            <b><?php echo nx_e('vpnapp.app.float.' . $nx_n . '.title'); ?></b>
            <i><?php echo nx_e('vpnapp.app.float.' . $nx_n . '.sub'); ?></i>
          </span>
        <?php endfor; ?>
      </div>
      <figcaption class="artnote"><?php echo nx_e('home.app.caption'); ?></figcaption>
    </figure>
  </div>
</section>

<!-- =========================== Security ========================= -->
<section class="section section--alt" id="security" aria-labelledby="h-security">
  <div class="wrap secure">
    <div class="section-head secure__head reveal">
      <span class="eyebrow"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2 class="h2" id="h-security"><?php echo nx_e('home.security.title'); ?></h2>
      <p class="lede"><?php echo nx_e('vpnapp.security.body'); ?></p>
    </div>

    <?php /* As on the home page, the protected leg STOPS at our servers. */ ?>
    <div class="secure__body">
    <figure class="reveal">
      <div class="flow" role="img" aria-label="<?php echo nx_e('vpnapp.security.diagram.alt'); ?>">
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('monitor'); ?></span><span><?php echo nx_e('home.security.diagram.you'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span><span class="flow__tag"><?php echo nx_icon('lock'); ?><?php echo nx_e('home.security.diagram.tunnel'); ?></span></div>
        <div class="flow__node flow__node--ok" aria-hidden="true"><span class="ico"><?php echo nx_icon('server'); ?></span><span><?php echo nx_e('home.security.diagram.server'); ?></span></div>
        <div class="flow__link flow__link--plain" aria-hidden="true"><span class="flow__line"></span></div>
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('globe'); ?></span><span><?php echo nx_e('home.security.diagram.internet'); ?></span></div>
      </div>
      <figcaption class="flow__caption"><?php echo nx_e('home.security.diagram.caption'); ?></figcaption>
    </figure>

    <ul class="ledger u-list-reset">
      <?php
      $nx_ledger = array(
          array('shield-check', 'home.security.point1'),
          array('lock', 'home.security.point2'),
          array('file-off', 'vpnapp.security.logs'),
      );
      foreach ($nx_ledger as $nx_row): ?>
        <li class="reveal">
          <span class="ico"><?php echo nx_icon($nx_row[0]); ?></span>
          <div>
            <h3><?php echo nx_e($nx_row[1] . '.title'); ?></h3>
            <p><?php echo nx_e($nx_row[1] . '.body'); ?></p>
          </div>
        </li>
      <?php endforeach; ?>
    </ul>
    </div>
  </div>
</section>

<!-- ======================== In the app ========================== -->
<section class="section" aria-labelledby="h-features">
  <div class="wrap">
    <div class="split">
      <div class="split__body reveal">
        <span class="eyebrow"><?php echo nx_e('vpnapp.features.eyebrow'); ?></span>
        <h2 class="h2" id="h-features"><?php echo nx_e('vpnapp.features.title'); ?></h2>
        <p class="body"><?php echo nx_e('vpnapp.features.body'); ?></p>
        <p><a class="link" href="<?php echo nx_esc(nx_url('features')); ?>"><?php echo nx_e('home.app.link'); ?><?php echo nx_icon('arrow-right'); ?></a></p>
      </div>

      <div class="grid grid--2 reveal">
        <article class="card feature feature--wide">
          <span class="ico"><?php echo nx_icon('layers'); ?></span>
          <h3><?php echo nx_e('features.split.title'); ?></h3>
          <p><?php echo nx_e('features.split.body'); ?></p>
          <p class="u-mt-sm"><?php echo nx_e('features.split.platforms'); ?></p>
        </article>
        <article class="card feature">
          <span class="ico"><?php echo nx_icon('chart'); ?></span>
          <h3><?php echo nx_e('features.usage.title'); ?></h3>
          <p><?php echo nx_e('features.usage.body'); ?></p>
        </article>
        <article class="card feature">
          <span class="ico"><?php echo nx_icon('message'); ?></span>
          <h3><?php echo nx_e('features.support.title'); ?></h3>
          <p><?php echo nx_e('features.support.body'); ?></p>
        </article>
        <article class="card feature feature--wide">
          <span class="ico"><?php echo nx_icon('refresh'); ?></span>
          <h3><?php echo nx_e('home.features.updates.title'); ?></h3>
          <p><?php echo nx_e('home.features.updates.body'); ?></p>
        </article>
      </div>
    </div>
  </div>
</section>

<!-- ============================ Quote =========================== -->
<section class="section quote" aria-label="<?php echo nx_e('home.quote.by'); ?>">
  <div class="wrap">
    <figure class="quote__fig reveal">
      <blockquote><p class="quote__text"><?php echo nx_e('vpnapp.quote'); ?></p></blockquote>
      <figcaption class="quote__by"><?php echo nx_e('home.quote.by'); ?></figcaption>
    </figure>
  </div>
</section>

<!-- ========================== Platforms ==========================
     What exists, from the same config as the download page. No buttons
     to files here: the download page has them, with its install notes. -->
<section class="section section--alt" aria-labelledby="h-platforms">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('vpnapp.platforms.eyebrow'); ?></span>
      <h2 class="h2" id="h-platforms"><?php echo nx_e('vpnapp.platforms.title'); ?></h2>
      <p class="lede"><?php echo nx_e('download.subtitle'); ?></p>
    </div>

    <div class="platforms reveal">
      <?php
      $nx_tiles = array();
      if ($nx_has_windows) {
          $nx_tiles[] = array('windows', 'download.windows.name', 'download.windows.requirements');
      }
      if (nx_android_available()) {
          $nx_tiles[] = array('android', 'download.android.name', 'download.android.requirements');
      }
      if (nx_ios_available()) {
          $nx_tiles[] = array('apple', 'download.ios.name', 'download.ios.requirements');
      }
      if (nx_linux_available()) {
          $nx_tiles[] = array('linux', 'download.linux.name', 'download.linux.requirements');
      }
      foreach ($nx_tiles as $nx_tile): ?>
        <article class="platform platform--ready">
          <span class="platform__glyph"><?php echo nx_platform_icon($nx_tile[0]); ?></span>
          <h3 class="platform__name"><?php echo nx_e($nx_tile[1]); ?></h3>
          <p class="platform__meta"><?php echo nx_e($nx_tile[2]); ?></p>
        </article>
      <?php endforeach; ?>
    </div>

    <p class="u-center u-mt-md">
      <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
        <span><?php echo nx_e('home.cta.button'); ?></span>
        <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
    </p>
  </div>
</section>

<!-- =========================== Pricing ==========================
     The two standard plans, with perks that say what they include. The
     plans page lists every plan. -->
<section class="section" id="pricing" aria-labelledby="h-pricing">
  <div class="wrap">
    <div class="section-head section-head--center reveal">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h2 class="h2" id="h-pricing"><?php echo nx_e('home.pricing.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.pricing.subtitle'); ?></p>
    </div>

    <div class="plans-pair">
      <?php
      $NX_PLAN_COMPACT = false;
      $NX_PLAN_STANDARD_ONLY = true;
      $NX_PLAN_PERKS = array('support');
      require NX_INC . '/partials/plan-cards.php';
      ?>
    </div>

    <?php if (nx_free_trial_enabled()): ?>
      <p class="trial"><?php echo nx_icon('ticket'); ?><span><?php echo nx_e('home.pricing.trial', array(
          'days' => $nx_trial_days, 'data' => $nx_trial_data)); ?></span></p>
    <?php endif; ?>
    <p class="note"><?php echo nx_e('home.pricing.note'); ?></p>

    <p class="u-center u-mt-md">
      <a class="link" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.pricing.link'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<section class="section section--alt" aria-labelledby="h-faq">
  <div class="wrap wrap--prose">
    <div class="section-head section-head--center reveal">
      <span class="eyebrow"><?php echo nx_e('vpnapp.faq.eyebrow'); ?></span>
      <h2 class="h2" id="h-faq"><?php echo nx_e('vpnapp.faq.title'); ?></h2>
    </div>

    <div class="faq reveal">
      <?php
      $nx_faq_keys = array('devices', 'protects', 'records', 'pay', 'contact');
      if (nx_free_trial_enabled()) {
          array_splice($nx_faq_keys, 1, 0, array('trial'));
      }
      foreach ($nx_faq_keys as $nx_q): ?>
        <details>
          <summary><?php echo nx_e('vpnapp.faq.' . $nx_q . '.q'); ?></summary>
          <div class="faq__answer"><p><?php echo nx_e('vpnapp.faq.' . $nx_q . '.a', array(
              'days' => $nx_trial_days, 'data' => $nx_trial_data)); ?></p></div>
        </details>
      <?php endforeach; ?>
    </div>

    <p class="u-center u-mt-md">
      <a class="link" href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('contact.title'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>

<!-- ============================ Close =========================== -->
<section class="section" aria-labelledby="h-close">
  <div class="wrap">
    <div class="close glass reveal">
      <span class="close__mark" aria-hidden="true"><?php echo nx_logo(); ?></span>
      <div class="close__copy">
        <span class="eyebrow"><?php echo nx_e('home.close.eyebrow'); ?></span>
        <h2 class="h2" id="h-close"><?php echo nx_e('vpnapp.close.title'); ?></h2>
        <p class="lede"><?php echo nx_e('vpnapp.close.body'); ?></p>
        <div class="close-list">
          <div><b><?php echo nx_e('home.close.point1.term'); ?></b><span><?php echo nx_e('home.close.point1.rest'); ?></span></div>
          <div><b><?php echo nx_e('home.close.point2.term'); ?></b><span><?php echo nx_e('home.close.point2.rest'); ?></span></div>
          <div><b><?php echo nx_e('vpnapp.close.point3.term'); ?></b><span><?php echo nx_e('vpnapp.close.point3.rest'); ?></span></div>
        </div>
      </div>
      <div class="close__actions">
        <a class="btn btn--primary btn--lg btn--magnet" href="<?php echo nx_esc($nx_cta_url); ?>"<?php echo $nx_cta_rel; ?>>
          <span><?php echo nx_e($nx_cta_label !== '' ? $nx_cta_label : 'home.cta.button'); ?></span>
          <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
        </a>
        <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.hero.cta_secondary'); ?></a>
        <p class="warnline"><?php echo nx_e('home.close.warn'); ?></p>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
