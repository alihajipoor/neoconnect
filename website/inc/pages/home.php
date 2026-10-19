<?php
/**
 * Home page template, shared by /index.php and /fa/index.php.
 *
 * Rebuilt 2026-10 in "pearl glass", the look the apps are moving to. The
 * order answers a buyer's questions in the order they arrive, and is kept
 * from the 2026-08 "Ladder" rebuild:
 *
 *   hero        what it is -- the app's own tagline over the dotted world
 *   simulator   the one genuinely distinctive thing, made playable
 *   methods     each connection method, what it is, when to pick it
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
 * no-logs claim (the shipped Xray config writes an access log), no kill
 * switch, no uptime figure, no user count, no refund guarantee, no signed
 * installer, and no speed or latency number anywhere. The illustration's
 * timer is labelled as an example beneath it.
 * ---------------------------------------------------------------------------
 */

defined('NX') || exit;

$nx_has_windows = nx_windows_available();
$nx_protocols = nx_protocols();
$nx_locations = nx_locations();
$nx_relay = nx_relay_location();

// The illustration connects to Germany over Stealth, because both exist:
// read from the content files so it can never name a place or a method
// the product does not have.
$nx_mock_loc = null;
foreach ($nx_locations as $nx_l) {
    if ($nx_l['code'] === 'de') {
        $nx_mock_loc = $nx_l;
    }
}
if ($nx_mock_loc === null && $nx_locations) {
    $nx_mock_loc = $nx_locations[0];
}
$nx_mock_proto = $nx_protocols ? $nx_protocols[0] : null;

// Every listed country gets a light; the connected one in the illustration
// is drawn larger. The relay entry is a ring, not a light: it is a way in.
$nx_lamp_codes = array();
foreach ($nx_locations as $nx_l) {
    $nx_lamp_codes[] = strtolower($nx_l['code']);
}

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="hero">
  <div class="wrap hero__inner">

    <div class="hero__copy">
      <?php require NX_INC . '/partials/announcement.php'; ?>

      <?php /* One h1: the kicker carries the words a search needs ("VPN",
               "filtered networks"); the tagline is the app's own, set as
               the app sets it. */ ?>
      <h1 class="hero__title">
        <span class="kicker"><?php echo nx_e('home.hero.kicker'); ?></span>
        <span class="tagline">
          <span><?php echo nx_e('home.hero.tagline_1'); ?></span>
          <span><?php echo nx_e('home.hero.tagline_2'); ?></span>
        </span>
      </h1>

      <p class="lede"><?php echo nx_e('home.hero.subtitle'); ?></p>

      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
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

    <?php /*
      The art: the dotted world with a light on every listed exit country,
      and the app floating over it, drawn in HTML from the app's own tokens
      so it follows the theme and the language. One text alternative for
      the whole figure; its parts are hidden from assistive technology.
    */ ?>
    <figure class="hero__art">
     <div class="hero__stage" role="img" aria-label="<?php echo nx_e('home.mockup.alt'); ?>">
      <div class="map" aria-hidden="true">
        <?php foreach ($nx_lamp_codes as $nx_cc): ?>
          <span class="lamp lamp--<?php echo nx_esc($nx_cc); ?><?php
            echo ($nx_mock_loc && $nx_cc === strtolower($nx_mock_loc['code'])) ? ' lamp--here' : ''; ?>"></span>
        <?php endforeach; ?>
        <?php if ($nx_relay): ?>
          <span class="lamp lamp--entry lamp--<?php echo nx_esc(strtolower($nx_relay['code'])); ?>"></span>
        <?php endif; ?>
      </div>

      <div class="mock glass" aria-hidden="true">
        <div class="mock__top">
          <span class="mock__word">NEOXIFY</span>
          <span class="mock__avatar">Y</span>
        </div>
        <span class="status"><?php echo nx_icon('check'); ?><?php echo nx_e('home.mockup.connected'); ?></span>
        <div>
          <p class="mock__timer"><?php echo nx_esc(nx_num('01:42:08')); ?></p>
          <p class="mock__hint"><?php echo nx_e('home.mockup.status'); ?></p>
        </div>
        <?php if ($nx_mock_proto): ?>
          <p class="mock__sub"><?php echo nx_icon('shuffle'); ?><span><?php
            echo str_replace(':method', '<b>' . nx_e_pick($nx_mock_proto['label']) . '</b>', nx_e('home.mockup.using')); ?></span></p>
        <?php endif; ?>
        <span class="mock__pill"><span><?php echo nx_e('home.mockup.disconnect'); ?></span><span class="mirror"><?php echo nx_icon('arrow-right'); ?></span></span>
        <?php if ($nx_mock_loc): ?>
          <div class="mock__row">
            <?php echo nx_flag_svg($nx_mock_loc['code']); ?>
            <span>
              <b><?php echo nx_e_pick($nx_mock_loc['country']); ?></b>
              <i><?php echo $nx_mock_proto ? nx_e_pick($nx_mock_proto['label']) : ''; ?><?php
                echo !empty($nx_mock_loc['city']) ? ' &middot; ' . nx_e_pick($nx_mock_loc['city']) : ''; ?></i>
            </span>
            <span class="go"><?php echo nx_icon('shuffle'); ?></span>
          </div>
        <?php endif; ?>
        <?php if ($nx_mock_proto): ?>
          <div class="mock__meters">
            <div class="mock__meter"><i><?php echo nx_e('home.mockup.method'); ?></i><b><?php echo nx_esc($nx_mock_proto['tech']); ?></b></div>
            <div class="mock__meter"><i><?php echo nx_e('home.mockup.transport'); ?></i><b><?php echo nx_esc($nx_mock_proto['transport']); ?></b></div>
          </div>
        <?php endif; ?>
      </div>
     </div>
      <figcaption class="artnote"><?php echo nx_e('home.mockup.note'); ?></figcaption>
    </figure>
  </div>
</section>

<!-- ========================= Simulator ==========================
     An illustration of how the client picks a transport. It probes
     nothing and measures nothing, and the note underneath says so. -->
<section class="section section--alt" id="methods" aria-labelledby="h-methods">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.inst.eyebrow'); ?></span>
      <h2 class="h2" id="h-methods"><?php echo nx_e('home.inst.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.inst.body'); ?></p>
    </div>

    <?php require NX_INC . '/partials/instrument.php'; ?>

    <p class="inst-note"><?php echo nx_e('home.inst.note'); ?></p>
  </div>
</section>

<!-- ========================== Methods =========================== -->
<?php if ($nx_protocols): ?>
<section class="section" id="protocols" aria-labelledby="h-protocols">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.protocols.eyebrow'); ?></span>
      <h2 class="h2" id="h-protocols"><?php echo nx_e('home.protocols.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.protocols.body'); ?></p>
    </div>

    <ul class="specimens u-list-reset">
      <?php $nx_n = 0; foreach ($nx_protocols as $nx_p): $nx_n++;
        $nx_blocked = isset($nx_p['blocked_by']) ? $nx_p['blocked_by'] : array();
        /* The verdict is DERIVED from how many kinds of filtering stop the
           method -- never typed, and never a success rate. */
        $nx_c = count($nx_blocked);
        if ($nx_c === 0) {
            $nx_tag = 'ok';   $nx_tag_key = 'home.protocols.tag.resists';
        } elseif ($nx_c <= 2) {
            $nx_tag = 'hl';   $nx_tag_key = 'home.protocols.tag.conditional';
        } else {
            $nx_tag = 'warn'; $nx_tag_key = 'home.protocols.tag.fragile';
        }
      ?>
        <li class="spec card reveal">
          <div class="spec__top">
            <span class="spec__no" data-ltr><?php echo sprintf('%02d', $nx_n); ?></span>
            <span class="tag tag--<?php echo $nx_tag; ?>"><span class="d" aria-hidden="true"></span><?php echo nx_e($nx_tag_key); ?></span>
          </div>
          <span class="spec__wave" aria-hidden="true">
            <svg viewBox="0 0 200 36" preserveAspectRatio="none" focusable="false">
              <path d="<?php echo nx_esc(nx_signal_path($nx_n * 613 + 41, 200, 36, $nx_p['kind'])); ?>"
                    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
            </svg>
          </span>
          <h3><?php echo nx_e_pick($nx_p['label']); ?></h3>
          <span class="spec__tech"><span data-ltr><?php echo nx_esc($nx_p['tech']); ?> &middot; <?php echo nx_esc($nx_p['transport']); ?></span></span>
          <p class="spec__hint"><?php echo nx_e_pick($nx_p['hint']); ?></p>
          <?php /* Per-platform availability, stated plainly. OpenVPN is not in
                   the Android client, and a phone user must not expect it. */ ?>
          <div class="spec__avail">
            <?php foreach (array('windows', 'android') as $nx_os):
              $nx_ok = !empty($nx_p[$nx_os]); ?>
              <span class="tag<?php echo $nx_ok ? ' tag--ok' : ''; ?>">
                <?php echo $nx_ok ? nx_icon('check') : nx_icon('minus'); ?>
                <?php echo nx_e('common.' . $nx_os); ?>
                <span class="sr-only"><?php echo $nx_ok ? nx_e('common.yes') : nx_e('common.no'); ?></span>
              </span>
            <?php endforeach; ?>
          </div>
        </li>
      <?php endforeach; ?>
    </ul>

    <p class="u-mt-lg">
      <a class="link" href="<?php echo nx_esc(nx_url('features')); ?>#protocols"><?php echo nx_e('home.protocols.link'); ?><?php echo nx_icon('arrow-right'); ?></a>
    </p>
  </div>
</section>
<?php endif; ?>

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
        <div class="map" aria-hidden="true">
          <?php foreach ($nx_lamp_codes as $nx_cc): ?>
            <span class="lamp lamp--<?php echo nx_esc($nx_cc); ?>"></span>
          <?php endforeach; ?>
          <?php if ($nx_relay): ?>
            <span class="lamp lamp--entry lamp--<?php echo nx_esc(strtolower($nx_relay['code'])); ?>"></span>
          <?php endif; ?>
        </div>
        <p class="legend">
          <span><i aria-hidden="true"></i><?php echo nx_e('home.locations.legend_exit'); ?></span>
          <?php if ($nx_relay): ?>
            <span><i class="entry" aria-hidden="true"></i><?php echo nx_e('home.locations.legend_entry'); ?></span>
          <?php endif; ?>
        </p>
      </div>

      <div class="exits__list reveal">
        <?php require NX_INC . '/partials/locations-grid.php'; ?>
        <?php if ($nx_relay): ?>
          <div class="callout callout--info u-mt-sm">
            <?php echo nx_icon('route'); ?>
            <p><?php echo nx_e('home.locations.relay_note'); ?></p>
          </div>
        <?php endif; ?>
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
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2 class="h2" id="h-security"><?php echo nx_e('home.security.title'); ?></h2>
      <p class="lede"><?php echo nx_e('home.security.body'); ?></p>
    </div>

    <?php /* The protected leg STOPS at our servers, because that is where a
             VPN's protection ends. Do not redraw this as one unbroken line
             to the internet. */ ?>
    <figure class="reveal">
      <div class="flow" role="img" aria-label="<?php echo nx_e('home.security.diagram.alt'); ?>">
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('monitor'); ?></span><span><?php echo nx_e('home.security.diagram.you'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span><span class="flow__tag"><?php echo nx_icon('lock'); ?><?php echo nx_e('home.security.diagram.tunnel'); ?></span></div>
        <div class="flow__node flow__node--ok" aria-hidden="true"><span class="ico"><?php echo nx_icon('server'); ?></span><span><?php echo nx_e('home.security.diagram.server'); ?></span></div>
        <div class="flow__link flow__link--plain" aria-hidden="true"><span class="flow__line"></span></div>
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('globe'); ?></span><span><?php echo nx_e('home.security.diagram.internet'); ?></span></div>
      </div>
      <figcaption class="flow__caption"><?php echo nx_e('home.security.diagram.caption'); ?></figcaption>
    </figure>

    <div class="grid grid--3 u-mt-lg">
      <?php
      $nx_glyphs = array('shield-check', 'lock', 'file-off');
      foreach (array('point1', 'point2', 'point3') as $nx_i => $nx_key): ?>
        <article class="card feature reveal">
          <span class="ico"><?php echo nx_icon($nx_glyphs[$nx_i]); ?></span>
          <h3><?php echo nx_e('home.security.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.security.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
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

    <div class="grid grid--4">
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
          <span class="n" data-ltr aria-hidden="true"><?php echo sprintf('%02d', $nx_a); ?></span>
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
      <span class="close__ring" aria-hidden="true"><?php echo nx_glass_ring(); ?></span>
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
        <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
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
