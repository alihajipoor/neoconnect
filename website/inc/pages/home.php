<?php
/**
 * Home page template, shared by /index.php and /fa/index.php.
 *
 * Rebuilt 2026-08 into "The Ladder": a light, full-bleed technical
 * broadsheet. The order below is deliberate and worth keeping, because it
 * answers a buyer's questions in the order they actually arrive:
 *
 *   hero        what it is
 *   marquee     the methods, named, as pure texture
 *   instrument  the one genuinely distinctive thing, made playable
 *   specimens   each method, what it looks like on the wire, when to pick it
 *   exits       where does my traffic come out
 *   no-config   why this is not the config link you usually buy
 *   security    what "encrypted" honestly means, and where it stops
 *   trust       what we will and will not claim
 *   pricing     what it costs
 *   answers     the five things every other VPN site says, struck out
 *   faq         the remaining objections
 *   close       the call to action
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND MUST NOT COME BACK.
 *
 * THE COUNTED STAT STRIP. This page used to open with "8 ways to connect /
 * 5 server countries / Windows + Android", counted live from the content
 * files. The counts are gone at the owner's instruction: the fleet changes,
 * protocols get added and retired, and a number baked into the home page is
 * a number that goes wrong without anyone noticing. The hero chips say what
 * is true without counting it, and there is no "eight protocols" or "six
 * locations" -- in either language -- anywhere on this site.
 *
 * Also absent, and all deliberate: no no-logs claim (the shipped Xray config
 * writes an access log), no kill switch, no uptime figure, no user count, no
 * refund guarantee, no signed installer, and no speed or latency number
 * anywhere. Every statement on this page describes something the product
 * actually does.
 * ---------------------------------------------------------------------------
 *
 * Everything visible comes from inc/lang/*.php and the content files, so the
 * Persian page is a genuine translation rather than a second layout.
 */

defined('NX') || exit;

$nx_has_windows = nx_windows_available();
$nx_protocols = nx_protocols();
$nx_locations = nx_locations();
$nx_relay = nx_relay_location();

require NX_INC . '/partials/head.php';

// Above the hero, in the flow. Home page only.
require NX_INC . '/partials/announcement.php';
?>

<!-- ============================ Hero ============================
     Twelve columns: the headline takes seven and the app mockup five.
     Deliberately not a centred column with a picture beside it. -->
<section class="hero">
  <div class="container hero__inner">

    <div class="hero__copy">
      <span class="eyb reveal"><?php echo nx_e('home.hero.eyebrow'); ?></span>

      <h1 class="d-xl reveal reveal--d1">
        <span><?php echo nx_e('home.hero.title'); ?></span>
        <span class="gradient-text"><?php echo nx_e('home.hero.title_accent'); ?></span>
      </h1>

      <p class="lede reveal reveal--d2"><?php echo nx_e('home.hero.subtitle'); ?></p>

      <?php /* Three statements of fact, none of them a count. The warn dot on
               the third is the honest one: the app is in beta. */ ?>
      <div class="hero-meta reveal reveal--d3">
        <span class="chip">
          <span class="d d-ok" aria-hidden="true"></span>
          <span><?php echo nx_e('home.hero.chip_locations'); ?></span>
        </span>
        <span class="chip">
          <span class="d d-ok" aria-hidden="true"></span>
          <span><?php echo nx_e('home.hero.chip_noconfig'); ?></span>
        </span>
        <?php if (nx_beta()): ?>
          <span class="chip">
            <span class="d d-warn" aria-hidden="true"></span>
            <span><?php echo nx_e('beta.hero'); ?></span>
          </span>
        <?php endif; ?>
      </div>

      <div class="hero__actions reveal reveal--d3">
        <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
          <?php echo nx_icon('download'); ?>
          <span><?php echo $nx_has_windows
              ? nx_e('home.hero.cta_primary')
              : nx_e('home.hero.cta_primary_soon'); ?></span>
        </a>
        <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>">
          <?php echo nx_e('home.hero.cta_secondary'); ?>
        </a>
      </div>

      <?php /* The unsigned-installer warning. It stays until there is a
               signing certificate: someone who meets a SmartScreen prompt
               without being told reasonably assumes the file is suspect. */ ?>
      <p class="hero__note reveal reveal--d4">
        <?php echo nx_icon('alert'); ?>
        <span><?php echo $nx_has_windows
            ? nx_e('home.hero.note_available')
            : nx_e('home.hero.note_soon'); ?></span>
      </p>
    </div>

    <?php /*
      The app, drawn in CSS from the real desktop client -- every token comes
      from its theme.css and the orb geometry from ConnectOrb.tsx. No
      screenshot exists and none is faked.

      One text alternative on the wrapper, everything inside aria-hidden: it
      is an illustration, and reading out two dozen mock UI labels would help
      nobody.
    */ ?>
    <div class="hero__art reveal reveal--d2">
      <div class="app" role="img" aria-label="<?php echo nx_e('home.mockup.alt'); ?>">
        <div class="device__bar" aria-hidden="true">
          <span class="device__dots"><i></i><i></i><i></i></span>
          <span class="device__title" data-ltr>NEOXIFY</span>
        </div>

        <div class="app__body" aria-hidden="true">
          <div class="app__head-actions">
            <span class="app__brand">
              <span class="app__mark"><?php echo nx_logo_mark(); ?></span>
              <b data-ltr>Neoxify</b>
            </span>
            <span class="app__muted"><?php echo nx_icon('shield'); ?></span>
          </div>

          <p class="app__muted">
            <span class="d"></span><span data-ltr>you@example.com</span>
          </p>

          <div class="app__connect">
            <span class="orb-ring"></span>
            <span class="orb-ring orb-ring--b"></span>
            <span class="orb-bloom"></span>
            <svg class="orb-svg" viewBox="0 0 128 128" focusable="false">
              <circle cx="64" cy="64" r="54" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3.5"/>
              <circle cx="64" cy="64" r="54" fill="none" stroke="url(#nx-orb)" stroke-width="3.5"
                      stroke-linecap="round" stroke-dasharray="298.57 339.29" transform="rotate(-90 64 64)"/>
            </svg>
            <span class="app__orb">
              <?php echo nx_icon('shield-check'); ?>
              <span><?php echo nx_e('home.mockup.disconnect'); ?></span>
            </span>
          </div>

          <div class="app__status">
            <b><?php echo nx_e('home.mockup.connected'); ?></b>
            <p><?php echo nx_e('home.mockup.status'); ?></p>
          </div>

          <div class="app__card">
            <span class="tx">
              <b><?php echo nx_e('home.mockup.location'); ?></b>
              <i data-ltr>VLESS &middot; REALITY</i>
            </span>
            <span class="ch mirror"><?php echo nx_icon('arrow-right'); ?></span>
          </div>

          <div class="app__meter">
            <div>
              <i><?php echo nx_e('home.mockup.used'); ?></i>
              <b data-ltr>&mdash;</b>
            </div>
            <div>
              <i><?php echo nx_e('home.mockup.expires'); ?></i>
              <b data-ltr>&mdash;</b>
            </div>
          </div>
        </div>
      </div>

      <p class="artnote"><?php echo nx_e('home.mockup.note'); ?></p>
    </div>
  </div>
</section>

<!-- ========================== Marquee ===========================
     Pure texture: the method names, outlined, drifting in opposite
     directions. Decorative, so aria-hidden -- every one of these words
     appears as real text in the specimen sheet below. -->
<div class="tick" data-tick aria-hidden="true">
  <div class="tick__row tick__row--a">
    <?php for ($nx_r = 0; $nx_r < 2; $nx_r++): ?>
      <?php $nx_n = 0; foreach ($nx_protocols as $nx_p): $nx_n++; ?>
        <i class="<?php echo $nx_n === 1 ? 'gr' : ''; ?>"><?php echo nx_esc($nx_p['tech']); ?></i>
        <i class="dot">&middot;</i>
      <?php endforeach; ?>
    <?php endfor; ?>
  </div>
  <div class="tick__row tick__row--b">
    <?php for ($nx_r = 0; $nx_r < 2; $nx_r++): ?>
      <?php $nx_n = 0; foreach (array_reverse($nx_protocols) as $nx_p): $nx_n++; ?>
        <i class="<?php echo $nx_n === 3 ? 'on' : ''; ?>"><?php echo nx_e_pick($nx_p['label']); ?></i>
        <i class="dot">&middot;</i>
      <?php endforeach; ?>
    <?php endfor; ?>
  </div>
</div>

<!-- ========================= Instrument =========================
     The interactive centrepiece. An illustration of how the client picks
     a transport -- it probes nothing and measures nothing, and the note
     underneath says so in both locales. -->
<section class="band band-2 pad" id="methods">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.inst.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.inst.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.inst.body'); ?></p>
    </div>

    <?php require NX_INC . '/partials/instrument.php'; ?>

    <p class="pricenote reveal"><?php echo nx_e('home.inst.note'); ?></p>
  </div>
</section>

<!-- ========================== Specimens =========================
     Each connection method as a specimen card: its trace, its transport,
     when you would pick it, and how it fares under filtering. -->
<section class="band pad" id="protocols">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.protocols.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.protocols.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.protocols.body'); ?></p>
    </div>
  </div>

  <div class="specimens">
    <?php $nx_n = 0; foreach ($nx_protocols as $nx_p): $nx_n++;
      $nx_blocked = isset($nx_p['blocked_by']) ? $nx_p['blocked_by'] : array();

      /* The verdict tag is DERIVED from how many kinds of filtering stop
         this method -- never typed, and never a success rate. Nothing here
         claims how often anything works, only what stops it. */
      $nx_c = count($nx_blocked);
      if ($nx_c === 0) {
          $nx_tag = 'ok';   $nx_tag_key = 'home.protocols.tag.resists';
      } elseif ($nx_c <= 2) {
          $nx_tag = 'warn'; $nx_tag_key = 'home.protocols.tag.conditional';
      } else {
          $nx_tag = 'bad';  $nx_tag_key = 'home.protocols.tag.fragile';
      }
    ?>
      <article class="spec reveal reveal--d<?php echo ($nx_n % 4) + 1; ?>">
        <span class="no" data-ltr><?php echo sprintf('%02d', $nx_n); ?></span>

        <span class="wave" aria-hidden="true">
          <svg viewBox="0 0 200 44" preserveAspectRatio="none" focusable="false">
            <path d="<?php echo nx_esc(nx_signal_path($nx_n * 613 + 41, 200, 44, $nx_p['kind'])); ?>"
                  fill="none" stroke="url(#nx-beam)" stroke-width="1.6"
                  stroke-linejoin="round" opacity=".85"/>
          </svg>
        </span>

        <h3><?php echo nx_e_pick($nx_p['label']); ?></h3>
        <span class="tech" data-ltr><?php
          echo nx_esc($nx_p['tech']) . ' &middot; ' . nx_esc($nx_p['transport']);
        ?></span>

        <p class="note"><?php echo nx_e_pick($nx_p['hint']); ?></p>

        <?php /* Per-platform availability, stated plainly. OpenVPN is not in
                 the Android client's supported set, and a customer on a phone
                 must not read this card and expect it to be there. */ ?>
        <span class="avail">
          <span class="<?php echo !empty($nx_p['windows']) ? 'yes' : 'no'; ?>" data-ltr>Windows</span>
          <span class="<?php echo !empty($nx_p['android']) ? 'yes' : 'no'; ?>" data-ltr>Android</span>
        </span>

        <span class="verdict-tag t-<?php echo $nx_tag; ?>">
          <span class="d" aria-hidden="true"></span><?php echo nx_e($nx_tag_key); ?>
        </span>
      </article>
    <?php endforeach; ?>
  </div>

  <div class="bleed u-mt-lg">
    <a class="section-link" href="<?php echo nx_esc(nx_url('features')); ?>#protocols">
      <?php echo nx_e('home.protocols.link'); ?>
      <?php echo nx_icon('arrow-right'); ?>
    </a>
  </div>
</section>

<!-- ============================ Exits =========================== -->
<?php if ($nx_locations): ?>
<section class="band band-2 pad" id="locations">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.locations.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.locations.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.locations.body'); ?></p>
    </div>
  </div>

  <div class="exits">
    <?php $nx_n = 0; foreach ($nx_locations as $nx_loc): $nx_n++; ?>
      <div class="exit reveal reveal--d<?php echo ($nx_n % 4) + 1; ?>">
        <?php echo nx_flag_svg($nx_loc['code']); ?>
        <b><?php echo nx_e_pick($nx_loc['country']); ?></b>
        <?php if (!empty($nx_loc['city'])): ?>
          <i><?php echo nx_e_pick($nx_loc['city']); ?></i>
        <?php endif; ?>
      </div>
    <?php endforeach; ?>

    <?php /* The relay is rendered here, but as its own kind of thing rather
             than as one more exit -- it is an entry point inside Iran, not a
             country your traffic comes out in. */ ?>
    <?php if ($nx_relay): ?>
      <div class="exit exit--relay reveal">
        <?php echo nx_flag_svg($nx_relay['code']); ?>
        <b><?php echo nx_e_pick($nx_relay['country']); ?></b>
        <i><?php echo nx_e('locations.relay_label'); ?></i>
      </div>
    <?php endif; ?>
  </div>

  <div class="bleed">
    <div class="callout callout--info u-mt-lg">
      <?php echo nx_icon('route'); ?>
      <div><p><?php echo nx_e('home.locations.relay_note'); ?></p></div>
    </div>
  </div>
</section>
<?php endif; ?>

<!-- ===================== No config files ======================== -->
<section class="band pad">
  <div class="bleed">
    <div class="split">
      <div class="split__body reveal">
        <span class="eyb"><?php echo nx_e('home.config.eyebrow'); ?></span>
        <h2 class="d-md"><?php echo nx_e('home.config.title'); ?></h2>
        <p class="body"><?php echo nx_e('home.config.body'); ?></p>

        <ul class="checklist">
          <?php foreach (array('point1', 'point2', 'point3') as $nx_pt): ?>
            <li>
              <?php echo nx_icon('check'); ?>
              <span><?php echo nx_e('home.config.' . $nx_pt); ?></span>
            </li>
          <?php endforeach; ?>
        </ul>
      </div>

      <div class="split__media reveal reveal--d2">
        <div class="bento">
          <div class="bento__cell bento__cell--wide">
            <span class="bento__icon"><?php echo nx_icon('layers'); ?></span>
            <h3><?php echo nx_e('features.split.example.bank.title'); ?></h3>
            <p><?php echo nx_e('features.split.example.bank.body'); ?></p>
          </div>
          <div class="bento__cell">
            <span class="bento__icon"><?php echo nx_icon('refresh'); ?></span>
            <h3><?php echo nx_e('features.usage.title'); ?></h3>
            <p><?php echo nx_e('features.usage.body'); ?></p>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- =========================== Security ========================= -->
<section class="band band-2 pad" id="security">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.security.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.security.body'); ?></p>
    </div>

    <?php /* The protected leg STOPS at our servers rather than running all
             the way to the destination, because that is where a VPN's
             protection actually ends. Do not redraw this as one unbroken
             line to the internet. */ ?>
    <div class="reveal">
      <div class="flow">
        <div class="flow__node">
          <?php echo nx_icon('monitor'); ?>
          <span><?php echo nx_e('home.security.diagram.you'); ?></span>
        </div>

        <div class="flow__link">
          <span class="flow__line"></span>
          <span class="flow__tag">
            <?php echo nx_icon('lock'); ?>
            <?php echo nx_e('home.security.diagram.tunnel'); ?>
          </span>
        </div>

        <div class="flow__node">
          <?php echo nx_icon('server'); ?>
          <span><?php echo nx_e('home.security.diagram.server'); ?></span>
        </div>

        <div class="flow__link flow__link--plain">
          <span class="flow__line"></span>
        </div>

        <div class="flow__node flow__node--end">
          <?php echo nx_icon('globe'); ?>
          <span><?php echo nx_e('home.security.diagram.internet'); ?></span>
        </div>
      </div>

      <p class="flow__caption"><?php echo nx_e('home.security.diagram.caption'); ?></p>
    </div>

    <div class="grid grid--3 u-mt-lg">
      <?php
      $nx_glyphs = array('shield-check', 'lock', 'file-off');
      foreach (array('point1', 'point2', 'point3') as $nx_i => $nx_key): ?>
        <article class="card reveal reveal--d<?php echo $nx_i + 1; ?>">
          <div class="card__icon"><?php echo nx_icon($nx_glyphs[$nx_i]); ?></div>
          <h3><?php echo nx_e('home.security.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.security.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- ============================ Trust ===========================
     The section that would normally hold invented badges: "audited",
     "no logs", "10 million users". None of those are true here, so this
     states what IS true instead, including the unflattering parts. Do not
     add a trust badge to this section that cannot be pointed at. -->
<section class="band pad" id="trust">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.trust.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.trust.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.trust.body'); ?></p>
    </div>

    <div class="grid grid--4">
      <?php
      $nx_trust = array(
          'state'  => 'shield-check',
          'logs'   => 'file-off',
          'beta'   => 'activity',
          'honest' => 'route',
      );
      $nx_i = 0;
      foreach ($nx_trust as $nx_key => $nx_glyph): $nx_i++; ?>
        <article class="pillar reveal reveal--d<?php echo $nx_i; ?>">
          <span class="pillar__icon"><?php echo nx_icon($nx_glyph); ?></span>
          <h3><?php echo nx_e('home.trust.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.trust.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- =========================== Pricing ========================== -->
<section class="band band-2 pad" id="pricing">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.pricing.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.pricing.subtitle'); ?></p>
    </div>
  </div>

  <?php $NX_PLAN_COMPACT = false; require NX_INC . '/partials/plan-cards.php'; ?>

  <div class="bleed">
    <?php /* The trial is granted to a new account, not sold. It is a
             paragraph, never a card with a buy button, because there is no
             checkout behind it. */ ?>
    <?php if (nx_free_trial_enabled()): ?>
      <div class="trial-banner">
        <p><?php echo nx_e('home.pricing.trial', array(
            'days' => nx_num((int) nx_cfg('free_trial_days', 30)))); ?></p>
      </div>
    <?php endif; ?>

    <p class="u-mt-lg">
      <a class="section-link" href="<?php echo nx_esc(nx_url('pricing')); ?>">
        <?php echo nx_e('home.pricing.link'); ?>
        <?php echo nx_icon('arrow-right'); ?>
      </a>
    </p>
  </div>
</section>

<!-- ======================= Straight answers =====================
     The five things every other VPN site says, struck out, with what is
     actually true beside them. This is the site's position in one block:
     it is the VPN that does not overclaim. Every strike here is a claim
     THIS site refuses to make -- do not add one we could not defend
     refusing. -->
<section class="band pad" id="answers">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.answers.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.answers.title'); ?></h2>
      <p class="lede reveal reveal--d2"><?php echo nx_e('home.answers.body'); ?></p>
    </div>

    <div class="answers">
      <?php for ($nx_a = 1; $nx_a <= 5; $nx_a++): ?>
        <div class="ans reveal">
          <span class="n" data-ltr><?php echo sprintf('%02d', $nx_a); ?></span>

          <span class="claim">
            <?php echo nx_e('home.answers.' . $nx_a . '.claim'); ?>
            <span class="strike" aria-hidden="true">
              <svg viewBox="0 0 300 10" preserveAspectRatio="none" focusable="false">
                <path d="M2,6 C60,2 110,9 160,4 C210,0 260,7 298,3"/>
              </svg>
            </span>
          </span>

          <?php /* The bold lead is a separate key rather than <b> markup inside
                   one translated string: every value in inc/lang/*.php is
                   echoed through nx_e(), which escapes, so embedded tags
                   would render as literal angle brackets. Splitting the two
                   keeps the typography and keeps the escaping. */ ?>
          <p class="say">
            <b><?php echo nx_e('home.answers.' . $nx_a . '.lead'); ?></b>
            <?php echo nx_e('home.answers.' . $nx_a . '.say'); ?>
          </p>
        </div>
      <?php endfor; ?>
    </div>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<?php $nx_faq = array_slice(nx_visible_faq(), 0, 5); ?>
<?php if ($nx_faq): ?>
<section class="band band-2 pad">
  <div class="bleed">
    <div class="head">
      <span class="eyb reveal"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.faq.title'); ?></h2>
    </div>

    <div class="faq">
      <?php foreach ($nx_faq as $nx_item): ?>
        <details>
          <summary><?php echo nx_e_pick($nx_item['q']); ?></summary>
          <div class="faq__answer"><p><?php echo nx_e_pick($nx_item['a']); ?></p></div>
        </details>
      <?php endforeach; ?>
    </div>

    <p class="u-mt-lg">
      <a class="section-link" href="<?php echo nx_esc(nx_url('faq')); ?>">
        <?php echo nx_e('home.faq.link'); ?>
        <?php echo nx_icon('arrow-right'); ?>
      </a>
    </p>
  </div>
</section>
<?php endif; ?>

<!-- ============================ Close ===========================
     The one saturated block on the page, and it closes the argument. -->
<section class="band pad flood">
  <div class="bleed close">
    <div class="close__lhs">
      <span class="eyb reveal"><?php echo nx_e('home.close.eyebrow'); ?></span>
      <h2 class="d-lg"><?php echo nx_e('home.cta.title'); ?></h2>
      <p class="lede reveal reveal--d1"><?php echo nx_e('home.cta.body'); ?></p>

      <div class="close-list">
        <?php for ($nx_c = 1; $nx_c <= 3; $nx_c++): ?>
          <div>
            <b><?php echo nx_e('home.close.point' . $nx_c . '.term'); ?></b>
            <span><?php echo nx_e('home.close.point' . $nx_c . '.rest'); ?></span>
          </div>
        <?php endfor; ?>
      </div>
    </div>

    <div class="close__rhs">
      <a class="btn btn--primary btn--lg reveal reveal--d1"
         href="<?php echo nx_esc(nx_url('download')); ?>">
        <span><?php echo nx_e('home.cta.button'); ?></span>
        <span class="mirror"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
      <a class="btn btn--ghost btn--lg reveal reveal--d2"
         href="<?php echo nx_esc(nx_url('pricing')); ?>">
        <?php echo nx_e('home.hero.cta_secondary'); ?>
      </a>
      <p class="warnline reveal reveal--d3"><?php echo nx_e('home.close.warn'); ?></p>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
