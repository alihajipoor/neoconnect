<?php
/**
 * Home page template, shared by /index.php and /fa/index.php.
 *
 * Rebuilt 2026-10 in "pearl glass", the look the apps are moving to. The
 * order answers a buyer's questions in the order they arrive, and is kept
 * from the 2026-08 "Ladder" rebuild:
 *
 *   hero        what it is -- the glass logo and the app's own tagline, over
 *               the aurora and the dotted world with its light lines
 *   app         the real app, in a phone (a real screenshot, captioned)
 *   methods     how it stays connected, described by what it does for you
 *   exits       where your traffic comes out (the map and the list)
 *   no-config   why this is not the config link you usually buy
 *   security    what "encrypted" honestly means, and where it stops
 *   trust       what we will and will not claim
 *   pricing     what it costs
 *   answers     the claims every other VPN site makes, struck out
 *   faq         the remaining objections
 *   close       the call to action
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND MUST NOT COME BACK.
 *
 * No counted stat strip ("8 ways to connect / 5 countries"): the fleet
 * changes and a number baked into the home page goes wrong unnoticed. No
 * no-logs claim (the shipped server config writes an access log), no kill
 * switch, no uptime figure, no user count, no refund guarantee, no signed
 * installer, and no speed or latency number anywhere. The illustration's
 * timer is labelled as an example beneath it.
 *
 * NO PROTOCOL, PORT, TRANSPORT, ROUTE OR ENTRY POINT IS NAMED OR DRAWN
 * ON THIS SITE, at the owner's instruction (2026-10-23). A public list of
 * how the app connects is a checklist for whoever is trying to block it.
 * Describe what the connection does for the customer, never how.
 * ---------------------------------------------------------------------------
 */

defined('NX') || exit;

$nx_has_windows = nx_windows_available();
$nx_locations = nx_locations();

// Floating beside the phone: what the app does for you, in a few words.
// Benefits only -- never a method's name.
$nx_float = array(1, 2, 3, 4);

/* The app screenshots: real Android screens (Play listing, 1080 x 1920),
   resized to three widths. One per theme; CSS shows the matching one and a
   lazy image that is not displayed is never fetched. */
$nx_shot = function ($variant) {
    $set = array();
    foreach (array(300, 450, 600) as $w) {
        $set[] = nx_asset('img/app/connected-' . $variant . '-' . $w . '.webp') . ' ' . $w . 'w';
    }
    return array('src' => nx_asset('img/app/connected-' . $variant . '-450.webp'), 'srcset' => implode(', ', $set));
};

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================
     Centred on the app's glass logo, over the living background: the
     aurora (head.php), the dotted world, its lights and the light lines.
     Nothing on the first screen animates in, so the largest paint is
     never held back. -->
<section class="hero">
  <?php echo nx_world('hero'); ?>
  <div class="wrap hero__inner">
    <?php require NX_INC . '/partials/announcement.php'; ?>

    <div class="hero__mark" aria-hidden="true">
      <span class="orbit"></span>
      <span class="orbit orbit--2"></span>
      <?php echo nx_logo('hero__logo'); ?>
    </div>

    <?php /* One h1: the kicker carries the words a search needs ("VPN",
             "filtered networks"); the tagline is the app's own. */ ?>
    <h1 class="hero__title">
      <span class="kicker"><?php echo nx_e('home.hero.kicker'); ?></span>
      <span class="tagline">
        <span><?php echo nx_e('home.hero.tagline_1'); ?></span>
        <span class="grad"><?php echo nx_e('home.hero.tagline_2'); ?></span>
      </span>
    </h1>

    <p class="lede"><?php echo nx_e('home.hero.subtitle'); ?></p>

    <div class="hero__actions">
      <a class="btn btn--primary btn--lg btn--magnet" href="<?php echo nx_esc(nx_url('download')); ?>">
        <span><?php echo $nx_has_windows
            ? nx_e('home.hero.cta_primary')
            : nx_e('home.hero.cta_primary_soon'); ?></span>
        <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
      <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.hero.cta_secondary'); ?></a>
    </div>

    <div class="chips">
      <span class="chip"><span class="dot" aria-hidden="true"></span><?php echo nx_e('home.hero.chip_locations'); ?></span>
      <span class="chip"><span class="dot" aria-hidden="true"></span><?php echo nx_e('home.hero.chip_noconfig'); ?></span>
      <?php if (nx_beta()): ?>
        <span class="chip"><span class="dot dot--warn" aria-hidden="true"></span><?php echo nx_e('beta.hero'); ?></span>
      <?php endif; ?>
    </div>

    <?php /* The unsigned-installer and platform note. It stays until there
             is a signing certificate. */ ?>
    <p class="hero__note">
      <?php echo nx_icon('info'); ?>
      <span><?php echo $nx_has_windows
          ? nx_e('home.hero.note_available')
          : nx_e('home.hero.note_soon'); ?></span>
    </p>
  </div>
</section>

<!-- ============================ The app =========================
     A real screenshot of the Android app, in a phone, captioned as one:
     the account, usage and address on it are a demo account's. -->
<section class="section showcase" aria-labelledby="h-app">
  <div class="wrap showcase__inner">
    <div class="showcase__copy reveal">
      <span class="eyebrow"><?php echo nx_e('home.app.eyebrow'); ?></span>
      <h2 class="h2" id="h-app"><?php echo nx_e('home.app.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.app.body'); ?></p>
      <ul class="checklist">
        <?php foreach (array('home.config.point1', 'home.config.point3', 'home.trust.state.title') as $nx_pt): ?>
          <li><?php echo nx_icon('check'); ?><span><?php echo nx_e($nx_pt); ?></span></li>
        <?php endforeach; ?>
      </ul>
      <p><a class="link" href="<?php echo nx_esc(nx_url('features')); ?>"><?php echo nx_e('home.app.link'); ?><?php echo nx_icon('arrow-right'); ?></a></p>
    </div>

    <figure class="showcase__stage">
      <div class="showcase__scene">
        <span class="showcase__glow" aria-hidden="true"></span>
        <span class="orbit orbit--stage" aria-hidden="true"></span>
        <div class="phone">
          <?php foreach (array('light' => 'l', 'dark' => 'd') as $nx_v => $nx_cls): $nx_img = $nx_shot($nx_v); ?>
            <img class="phone__shot only-<?php echo $nx_v; ?>" src="<?php echo nx_esc($nx_img['src']); ?>"
                 srcset="<?php echo nx_esc($nx_img['srcset']); ?>" sizes="(max-width: 600px) 232px, 282px"
                 width="1080" height="1920" loading="lazy" decoding="async"
                 alt="<?php echo nx_e($nx_v === 'dark' ? 'home.app.alt_dark' : 'home.app.alt'); ?>">
          <?php endforeach; ?>
        </div>
        <?php foreach ($nx_float as $nx_n): ?>
          <span class="floater floater--<?php echo $nx_n; ?>" aria-hidden="true">
            <span class="floater__dot"></span>
            <b><?php echo nx_e('home.app.float.' . $nx_n . '.title'); ?></b>
            <i><?php echo nx_e('home.app.float.' . $nx_n . '.sub'); ?></i>
          </span>
        <?php endforeach; ?>
      </div>
      <figcaption class="artnote"><?php echo nx_e('home.app.caption'); ?></figcaption>
    </figure>
  </div>
</section>

<!-- ===================== The app, in four beats =================
     The real apps pinned while the story scrolls past: inc/partials/story.php.
     Described by what it does for the customer, never by name, port or
     transport -- see the note at the top of this file. -->
<section class="section story-sec" id="protocols" aria-labelledby="h-protocols">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.protocols.eyebrow'); ?></span>
      <h2 class="h2" id="h-protocols"><?php echo nx_e('home.protocols.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.protocols.body'); ?></p>
    </div>
    <?php require NX_INC . '/partials/story.php'; ?>
  </div>
</section>

<!-- ============================ Night ===========================
     A breath between the story and the facts: the dotted world as a field
     of stars at night, the server countries as the brightest of them, the
     glass logo floating in its own light, and one line. Always dark. -->
<section class="night" aria-labelledby="h-night">
  <?php echo nx_world('night'); ?>
  <div class="wrap night__inner">
    <div class="night__mark" aria-hidden="true"><?php echo nx_logo('night__logo'); ?></div>
    <h2 class="night__line reveal" id="h-night"><?php echo nx_e('home.night.line'); ?></h2>
  </div>
</section>

<!-- ============================ Exits =========================== -->
<?php if ($nx_locations): ?>
<section class="section section--alt" id="locations" aria-labelledby="h-locations">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.locations.eyebrow'); ?></span>
      <h2 class="h2" id="h-locations"><?php echo nx_e('home.locations.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.locations.body'); ?></p>
    </div>

    <div class="exits">
      <div class="exits__map card reveal">
        <?php /* The list beside it is the information; the map only shows
                 where those places sit. Anchors are one city per country,
                 for display -- never a server's location or address. */ ?>
        <?php echo nx_world('plain'); ?>
        <p class="legend">
          <span><i aria-hidden="true"></i><?php echo nx_e('home.locations.legend_exit'); ?></span>
        </p>
      </div>

      <div class="exits__list reveal">
        <?php require NX_INC . '/partials/locations-grid.php'; ?>
      </div>
    </div>
  </div>
</section>
<?php endif; ?>

<!-- ===================== No config files ======================== -->
<section class="section" aria-labelledby="h-config">
  <div class="wrap">
    <div class="split">
      <div class="split__body reveal">
        <span class="eyebrow"><?php echo nx_e('home.config.eyebrow'); ?></span>
        <h2 class="h2" id="h-config"><?php echo nx_e('home.config.title'); ?></h2>
        <p class="body"><?php echo nx_e('home.config.body'); ?></p>
        <ul class="checklist">
          <?php foreach (array('point1', 'point2', 'point3') as $nx_pt): ?>
            <li><?php echo nx_icon('check'); ?><span><?php echo nx_e('home.config.' . $nx_pt); ?></span></li>
          <?php endforeach; ?>
        </ul>
      </div>

      <div class="grid grid--2 reveal">
        <article class="card feature feature--wide">
          <span class="ico"><?php echo nx_icon('layers'); ?></span>
          <h3><?php echo nx_e('features.split.example.bank.title'); ?></h3>
          <p><?php echo nx_e('features.split.example.bank.body'); ?></p>
        </article>
        <article class="card feature">
          <span class="ico"><?php echo nx_icon('refresh'); ?></span>
          <h3><?php echo nx_e('home.features.updates.title'); ?></h3>
          <p><?php echo nx_e('home.features.updates.body'); ?></p>
        </article>
        <article class="card feature">
          <span class="ico"><?php echo nx_icon('chart'); ?></span>
          <h3><?php echo nx_e('features.usage.title'); ?></h3>
          <p><?php echo nx_e('features.usage.body'); ?></p>
        </article>
      </div>
    </div>
  </div>
</section>

<!-- =========================== Security ========================= -->
<section class="section section--alt" id="security" aria-labelledby="h-security">
  <div class="wrap secure">
    <div class="section-head secure__head reveal">
      <span class="eyebrow"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2 class="h2" id="h-security"><?php echo nx_e('home.security.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.security.body'); ?></p>
    </div>

    <div class="secure__body">
    <ul class="ledger u-list-reset">
      <?php
      $nx_glyphs = array('shield-check', 'lock', 'file-off');
      foreach (array('point1', 'point2', 'point3') as $nx_i => $nx_key): ?>
        <li class="reveal">
          <span class="ico"><?php echo nx_icon($nx_glyphs[$nx_i]); ?></span>
          <div>
            <h3><?php echo nx_e('home.security.' . $nx_key . '.title'); ?></h3>
            <p><?php echo nx_e('home.security.' . $nx_key . '.body'); ?></p>
          </div>
        </li>
      <?php endforeach; ?>
    </ul>
    </div>
  </div>
</section>

<!-- ============================ Trust ===========================
     The section that would normally hold invented badges. None of those
     are true here, so it states what IS true, including the unflattering
     parts. Do not add a badge that cannot be pointed at. -->
<section class="section" id="trust" aria-labelledby="h-trust">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.trust.eyebrow'); ?></span>
      <h2 class="h2" id="h-trust"><?php echo nx_e('home.trust.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.trust.body'); ?></p>
    </div>

    <div class="bento">
      <?php
      $nx_trust = array('state' => 'shield-check', 'logs' => 'file-off', 'beta' => 'activity', 'honest' => 'route');
      foreach ($nx_trust as $nx_key => $nx_glyph): ?>
        <article class="card pillar reveal">
          <span class="ico"><?php echo nx_icon($nx_glyph); ?></span>
          <h3><?php echo nx_e('home.trust.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.trust.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- ============================ Quote ===========================
     A sentence from the trust copy above, set large: the one idea the
     product is built on. Ours, not a customer's -- there are no reviews. -->
<section class="section quote" aria-label="<?php echo nx_e('home.quote.by'); ?>">
  <div class="wrap">
    <figure class="quote__fig reveal">
      <blockquote><p class="quote__text"><?php echo nx_e('home.quote'); ?></p></blockquote>
      <figcaption class="quote__by"><?php echo nx_e('home.quote.by'); ?></figcaption>
    </figure>
  </div>
</section>

<!-- =========================== Pricing ========================== -->
<section class="section section--alt" id="pricing" aria-labelledby="h-pricing">
  <div class="wrap">
    <div class="section-head section-head--center reveal">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h2 class="h2" id="h-pricing"><?php echo nx_e('home.pricing.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.pricing.subtitle'); ?></p>
    </div>

    <?php $NX_PLAN_COMPACT = false; require NX_INC . '/partials/plan-cards.php'; ?>

    <?php /* The trial is granted to a new account, not sold: a sentence,
             never a card with a buy button. */ ?>
    <?php if (nx_free_trial_enabled()): ?>
      <p class="trial"><?php echo nx_icon('ticket'); ?><span><?php echo nx_e('home.pricing.trial', array(
          'days' => nx_num((int) nx_cfg('free_trial_days', 30)))); ?></span></p>
    <?php endif; ?>
    <p class="note"><?php echo nx_e('home.pricing.note'); ?></p>

    <p class="u-center u-mt-md">
      <a class="link" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.pricing.link'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>

<!-- ======================= Straight answers =====================
     Claims this site refuses to make, struck out, with what is true
     beside them. Do not add one we could not defend refusing. -->
<section class="section" id="answers" aria-labelledby="h-answers">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.answers.eyebrow'); ?></span>
      <h2 class="h2" id="h-answers"><?php echo nx_e('home.answers.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.answers.body'); ?></p>
    </div>

    <ol class="answers u-list-reset">
      <?php for ($nx_a = 1; $nx_a <= 5; $nx_a++): ?>
        <li class="ans reveal">
          <span class="n" data-ltr aria-hidden="true"><?php echo nx_num(sprintf('%02d', $nx_a)); ?></span>
          <span class="claim">
            <del><?php echo nx_e('home.answers.' . $nx_a . '.claim'); ?></del>
            <span class="strike" aria-hidden="true">
              <svg viewBox="0 0 300 10" preserveAspectRatio="none" focusable="false"><path d="M2,6 C60,2 110,9 160,4 C210,0 260,7 298,3"/></svg>
            </span>
          </span>
          <p class="say"><b><?php echo nx_e('home.answers.' . $nx_a . '.lead'); ?></b> <?php echo nx_e('home.answers.' . $nx_a . '.say'); ?></p>
        </li>
      <?php endfor; ?>
    </ol>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<?php $nx_faq = array_slice(nx_visible_faq(), 0, 5); ?>
<?php if ($nx_faq): ?>
<section class="section section--alt" aria-labelledby="h-faq">
  <div class="wrap wrap--prose">
    <div class="section-head section-head--center reveal">
      <span class="eyebrow"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h2 class="h2" id="h-faq"><?php echo nx_e('home.faq.title'); ?></h2>
    </div>

    <div class="faq reveal">
      <?php foreach ($nx_faq as $nx_item): ?>
        <details>
          <summary><?php echo nx_e_pick($nx_item['q']); ?></summary>
          <div class="faq__answer"><p><?php echo nx_e_pick($nx_item['a']); ?></p></div>
        </details>
      <?php endforeach; ?>
    </div>

    <p class="u-center u-mt-md">
      <a class="link" href="<?php echo nx_esc(nx_url('faq')); ?>"><?php echo nx_e('home.faq.link'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>
<?php endif; ?>

<!-- ============================ Close =========================== -->
<section class="section" aria-labelledby="h-close">
  <div class="wrap">
    <div class="close glass reveal">
      <span class="close__mark" aria-hidden="true"><?php echo nx_logo(); ?></span>
      <div class="close__copy">
        <span class="eyebrow"><?php echo nx_e('home.close.eyebrow'); ?></span>
        <h2 class="h2" id="h-close"><?php echo nx_e('home.cta.title'); ?></h2>
        <p class="lede"><?php echo nx_e('home.cta.body'); ?></p>
        <div class="close-list">
          <?php for ($nx_c = 1; $nx_c <= 3; $nx_c++): ?>
            <div><b><?php echo nx_e('home.close.point' . $nx_c . '.term'); ?></b><span><?php echo nx_e('home.close.point' . $nx_c . '.rest'); ?></span></div>
          <?php endfor; ?>
        </div>
      </div>
      <div class="close__actions">
        <a class="btn btn--primary btn--lg btn--magnet" href="<?php echo nx_esc(nx_url('download')); ?>">
          <span><?php echo nx_e('home.cta.button'); ?></span>
          <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
        </a>
        <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('home.hero.cta_secondary'); ?></a>
        <p class="warnline"><?php echo nx_e('home.close.warn'); ?></p>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
