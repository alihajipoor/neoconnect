<?php
/**
 * Home page template, shared by /index.php and /fa/index.php.
 *
 * Rebuilt 2026-08 to be wide rather than narrow, and to answer the
 * questions a VPN buyer actually arrives with. The order below is
 * deliberate and worth keeping:
 *
 *   hero -> what it is
 *   stats -> is it substantial (counted, never typed)
 *   methods -> the one genuinely distinctive thing, named
 *   locations -> where does my traffic come out
 *   no-config -> why this is not the config link you usually buy
 *   local sites -> the problem people in Iran actually search for
 *   security -> what "encrypted" honestly means
 *   trust -> what we will and will not claim
 *   pricing -> what it costs
 *   faq -> the objections
 *   cta
 *
 * The reference site the design borrows from has no pricing, no FAQ and no
 * comparison anywhere -- which is fine for request-based B2B and would be
 * fatal here. The visual language is borrowed; the content model is not.
 *
 * Everything visible comes from inc/lang/*.php and the content files, so
 * the Persian page is a genuine translation rather than a second layout.
 */

defined('NX') || exit;

$nx_plans = nx_content('plans');
$nx_has_windows = nx_windows_available();

require NX_INC . '/partials/head.php';

// Above the hero, in the flow. Home page only.
require NX_INC . '/partials/announcement.php';
?>

<!-- ============================ Hero ============================ -->
<section class="hero">
  <div class="container hero__inner">

    <div>
      <span class="eyebrow"><?php echo nx_e('home.hero.eyebrow'); ?></span>
      <h1>
        <span><?php echo nx_e('home.hero.title'); ?></span>
        <span class="gradient-text"><?php echo nx_e('home.hero.title_accent'); ?></span>
      </h1>
      <p class="lead"><?php echo nx_e('home.hero.subtitle'); ?></p>

      <div class="hero__actions">
        <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
          <?php echo nx_icon('download'); ?>
          <?php echo $nx_has_windows
              ? nx_e('home.hero.cta_primary')
              : nx_e('home.hero.cta_primary_soon'); ?>
        </a>
        <a class="btn btn--ghost btn--lg" href="<?php echo nx_esc(nx_url('pricing')); ?>">
          <?php echo nx_e('home.hero.cta_secondary'); ?>
        </a>
      </div>

      <p class="hero__note">
        <?php if (nx_beta()): ?>
          <span class="hero__beta"><?php echo nx_e('beta.hero'); ?></span>
        <?php endif; ?>
        <?php echo $nx_has_windows
            ? nx_e('home.hero.note_available')
            : nx_e('home.hero.note_soon'); ?>
      </p>
    </div>

    <!--
      The app, drawn in CSS from the real desktop UI. No screenshot exists
      and none is faked. The macOS window and the phone were both badged
      "Soon" here; the phone no longer is, because Android shipped -- the
      macOS frame keeps its badge because that client genuinely does not
      exist.

      One text alternative on the wrapper, everything inside aria-hidden:
      it is an illustration, and reading out two dozen mock UI labels would
      help nobody.
    -->
    <div class="mockup" role="img" aria-label="<?php echo nx_e('home.mockup.alt'); ?>">

      <div class="device device--mac" aria-hidden="true">
        <div class="device__bar">
          <span class="device__dots"><i></i><i></i><i></i></span>
        </div>
        <div class="device__body"></div>
        <span class="device__soon">
          <?php echo nx_e('home.mockup.macos'); ?> · <?php echo nx_e('home.mockup.soon'); ?>
        </span>
      </div>

      <div class="device device--win" aria-hidden="true">
        <div class="device__bar">
          <span class="device__dots"><i></i><i></i><i></i></span>
          <span class="device__title"><?php echo nx_e('home.mockup.windows'); ?></span>
        </div>

        <div class="app">
          <div class="app__head">
            <span class="app__brand">
              <span class="app__mark"><?php echo nx_logo_mark(); ?></span>
              <?php echo nx_e('brand.name'); ?>
            </span>
            <span class="app__head-actions" aria-hidden="true"><i></i><i></i></span>
          </div>

          <div class="app__card">
            <div class="app__row">
              <span><?php echo nx_e('home.mockup.subscription'); ?></span>
              <span class="app__pill"><?php echo nx_e('home.mockup.status'); ?></span>
            </div>
            <p class="app__muted"><?php echo nx_e('home.mockup.expires'); ?></p>
            <p class="app__muted"><?php echo nx_e('home.mockup.used'); ?></p>
            <div class="app__meter"><i></i></div>
          </div>

          <div class="app__connect">
            <div class="app__orb"><?php echo nx_e('home.mockup.connected'); ?></div>
          </div>

          <div class="app__loc">
            <?php echo nx_icon('map-pin'); ?>
            <?php echo nx_e('home.mockup.location'); ?>
          </div>
        </div>
      </div>

      <div class="device device--phone" aria-hidden="true">
        <span class="phone__notch"></span>
        <div class="phone__screen">
          <div class="app__orb app__orb--sm"><?php echo nx_e('home.mockup.connected'); ?></div>
        </div>
      </div>

    </div>
  </div>
</section>

<!-- ========================== Stat strip ======================== -->
<section class="section section--tight u-flush-top">
  <div class="container">
    <?php
    /* Counted from the data files at render time. If a node is added or a
       protocol is dropped, these move by themselves -- which is the entire
       reason they are not typed into a translation string. */
    ?>
    <div class="stat-row reveal">
      <div class="stat">
        <span class="stat__value"><?php echo nx_num(nx_protocol_count()); ?></span>
        <span class="stat__label"><?php echo nx_e('home.stats.protocols'); ?></span>
      </div>
      <div class="stat">
        <span class="stat__value"><?php echo nx_num(nx_location_count()); ?></span>
        <span class="stat__label"><?php echo nx_e('home.stats.locations'); ?></span>
      </div>
      <div class="stat">
        <span class="stat__value"><?php echo nx_e('home.stats.platforms_value'); ?></span>
        <span class="stat__label"><?php echo nx_e('home.stats.platforms'); ?></span>
      </div>
    </div>
  </div>
</section>

<!-- ====================== Connection methods ==================== -->
<section class="section section--band" id="methods">
  <div class="container container--wide">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.protocols.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.protocols.title'); ?></h2>
      <p><?php echo nx_e('home.protocols.body'); ?></p>
    </div>

    <div class="reveal">
      <?php require NX_INC . '/partials/protocol-table.php'; ?>
    </div>

    <a class="section-link" href="<?php echo nx_esc(nx_url('features')); ?>#protocols">
      <?php echo nx_e('home.protocols.link'); ?>
      <?php echo nx_icon('arrow-right'); ?>
    </a>
  </div>
</section>

<!-- ========================== Locations ========================= -->
<section class="section" id="locations">
  <div class="container container--wide">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.locations.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.locations.title'); ?></h2>
      <p><?php echo nx_e('home.locations.body'); ?></p>
    </div>

    <div class="reveal">
      <?php require NX_INC . '/partials/locations-grid.php'; ?>
    </div>

    <div class="callout callout--info u-mt-lg">
      <?php echo nx_icon('route'); ?>
      <div>
        <p><?php echo nx_e('home.locations.relay_note'); ?></p>
      </div>
    </div>
  </div>
</section>

<!-- ===================== No config files ======================== -->
<section class="section section--band">
  <div class="container">
    <div class="split">
      <div class="split__body reveal">
        <span class="eyebrow"><?php echo nx_e('home.config.eyebrow'); ?></span>
        <h2><?php echo nx_e('home.config.title'); ?></h2>
        <p><?php echo nx_e('home.config.body'); ?></p>

        <ul class="checklist">
          <?php foreach (array('point1', 'point2', 'point3') as $nx_p): ?>
            <li>
              <?php echo nx_icon('check'); ?>
              <span><?php echo nx_e('home.config.' . $nx_p); ?></span>
            </li>
          <?php endforeach; ?>
        </ul>
      </div>

      <div class="split__media reveal">
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
<section class="section" id="security">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow"><?php echo nx_e('home.security.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.security.title'); ?></h2>
      <p><?php echo nx_e('home.security.body'); ?></p>
    </div>

    <!-- Shows the encrypted leg ending at our servers rather than running
         all the way to the destination, because that is where a VPN's
         protection actually stops. -->
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

    <div class="grid grid--3 u-mt-md">
      <?php foreach (array('point1', 'point2', 'point3') as $nx_i => $nx_key):
        $nx_glyphs = array('shield-check', 'lock', 'file-off');
        ?>
        <article class="card reveal">
          <div class="card__icon"><?php echo nx_icon($nx_glyphs[$nx_i]); ?></div>
          <h3><?php echo nx_e('home.security.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.security.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- ============================ Trust =========================== -->
<?php
/* The section that would normally hold invented badges: "audited",
   "no logs", "10 million users". None of those are true here, so this
   states what IS true instead, including the unflattering parts. Being
   the VPN that does not overclaim is a real position, and it is the only
   one this product can currently defend. Do not add a trust badge to this
   section that cannot be pointed at. */
?>
<section class="section section--band section--wash" id="trust">
  <div class="container container--wide">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.trust.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.trust.title'); ?></h2>
      <p><?php echo nx_e('home.trust.body'); ?></p>
    </div>

    <div class="grid grid--4">
      <?php
      $nx_trust = array(
          'state'  => 'shield-check',
          'logs'   => 'file-off',
          'beta'   => 'activity',
          'honest' => 'route',
      );
      foreach ($nx_trust as $nx_key => $nx_glyph): ?>
        <article class="pillar reveal">
          <span class="pillar__icon"><?php echo nx_icon($nx_glyph); ?></span>
          <h3><?php echo nx_e('home.trust.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('home.trust.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- =========================== Pricing ========================== -->
<section class="section" id="pricing">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.pricing.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.pricing.title'); ?></h2>
      <p><?php echo nx_e('home.pricing.subtitle'); ?></p>
    </div>

    <div class="grid grid--3">
      <?php foreach ($nx_plans['plans'] as $nx_plan):
        $nx_days = (int) $nx_plan['duration_days'];
        $nx_monthly = $nx_days === 30;
        ?>
        <div class="plan-wrap reveal">
          <?php if (!empty($nx_plan['highlight'])): ?>
            <span class="plan__badge"><?php echo nx_e('home.pricing.popular'); ?></span>
          <?php endif; ?>

          <article class="plan<?php echo !empty($nx_plan['highlight']) ? ' plan--featured' : ''; ?>">
            <div class="plan__name"><?php echo nx_esc(nx_pick($nx_plan['name'])); ?></div>
            <p class="plan__tagline"><?php echo nx_esc(nx_pick($nx_plan['tagline'])); ?></p>

            <div class="plan__price">
              <span class="plan__amount"><?php echo nx_esc(nx_price($nx_plan['price'])); ?></span>
              <span class="plan__period">
                <?php echo $nx_monthly
                    ? nx_e('home.pricing.per_month')
                    : nx_e('home.pricing.per_days', array('days' => nx_num($nx_days))); ?>
              </span>
            </div>

            <ul class="plan__features">
              <li>
                <?php echo nx_icon('check'); ?>
                <span><?php
                  if (!isset($nx_plan['data_gb']) || $nx_plan['data_gb'] === null) {
                      echo nx_e('home.pricing.data_unlimited');
                  } else {
                      $nx_amount = nx_format_data($nx_plan['data_gb']);
                      echo $nx_monthly
                          ? nx_e('home.pricing.data', array('amount' => $nx_amount))
                          : nx_e('home.pricing.data_period', array(
                                'amount' => $nx_amount, 'days' => nx_num($nx_days)));
                  }
                ?></span>
              </li>

              <?php if (array_key_exists('connections', $nx_plan)):
                  $nx_conn = $nx_plan['connections'];
                  if ($nx_conn === null) {
                      $nx_conn_text = nx_e('home.pricing.connections_unlimited');
                  } elseif ((int) $nx_conn === 1) {
                      $nx_conn_text = nx_e('home.pricing.connections_one');
                  } else {
                      $nx_conn_text = nx_e('home.pricing.connections',
                          array('count' => nx_num((int) $nx_conn)));
                  }
              ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php echo $nx_conn_text; ?></span>
                </li>
              <?php endif; ?>

              <?php
              $nx_perks = isset($nx_plan['perks']) && is_array($nx_plan['perks'])
                  ? $nx_plan['perks']
                  : array('all_modes', 'all_locations', 'relay_routes', 'support');
              foreach ($nx_perks as $nx_perk): ?>
                <li>
                  <?php echo nx_icon('check'); ?>
                  <span><?php echo nx_e('home.pricing.' . $nx_perk); ?></span>
                </li>
              <?php endforeach; ?>
            </ul>

            <?php if (!empty($nx_plan['coming_soon'])): ?>
              <button class="btn btn--ghost btn--block" type="button" disabled
                      aria-disabled="true">
                <?php echo nx_e('home.pricing.coming_soon'); ?>
              </button>
            <?php else: ?>
              <a class="btn <?php echo !empty($nx_plan['highlight']) ? 'btn--primary' : 'btn--ghost'; ?> btn--block"
                 href="<?php echo nx_esc(nx_buy_url(isset($nx_plan['id']) ? $nx_plan['id'] : '')); ?>">
                <?php echo nx_e('home.pricing.cta'); ?>
              </a>
            <?php endif; ?>
          </article>
        </div>
      <?php endforeach; ?>
    </div>

    <?php if (nx_free_trial_enabled()): ?>
      <p class="trial-banner">
        <?php echo nx_e('home.pricing.trial', array(
            'days' => nx_num((int) nx_cfg('free_trial_days', 30)))); ?>
      </p>
    <?php endif; ?>

    <p class="u-center">
      <a class="section-link" href="<?php echo nx_esc(nx_url('pricing')); ?>">
        <?php echo nx_e('home.pricing.link'); ?>
        <?php echo nx_icon('arrow-right'); ?>
      </a>
    </p>
  </div>
</section>

<!-- ============================= FAQ ============================ -->
<section class="section section--tight">
  <div class="container container--prose">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h2><?php echo nx_e('home.faq.title'); ?></h2>
    </div>

    <div class="faq">
      <?php
      /* Five here, the rest on the FAQ page. The full list used to be
         inline, which made the home page long and left the FAQ page with
         nothing exclusive to offer a crawler. */
      foreach (array_slice(nx_visible_faq(), 0, 5) as $nx_item): ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><?php echo nx_esc(nx_pick($nx_item['a'])); ?></div>
        </details>
      <?php endforeach; ?>
    </div>

    <p class="u-center u-mt-lg">
      <a class="section-link" href="<?php echo nx_esc(nx_url('faq')); ?>">
        <?php echo nx_e('home.faq.link'); ?>
        <?php echo nx_icon('arrow-right'); ?>
      </a>
    </p>
  </div>
</section>

<!-- ============================= CTA ============================ -->
<section class="section section--tight">
  <div class="container">
    <div class="cta-band">
      <h2><?php echo nx_e('home.cta.title'); ?></h2>
      <p><?php echo nx_e('home.cta.body'); ?></p>
      <a class="btn btn--primary btn--lg" href="<?php echo nx_esc(nx_url('download')); ?>">
        <?php echo nx_e('home.cta.button'); ?>
        <span class="icon-arrow"><?php echo nx_icon('arrow-right'); ?></span>
      </a>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
