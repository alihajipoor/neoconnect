<?php
/**
 * Features page, shared by /features/ and /fa/features/.
 *
 * New in the 2026-08 rebuild. Features previously existed only as three
 * cards on the home page, which meant the product's single most
 * distinctive thing -- eight connection methods, named -- had no page of
 * its own, no title, no canonical and nothing for a search engine to rank
 * against "wireguard vpn" or "shadowsocks" or their Persian equivalents.
 *
 * Everything on this page is driven by inc/content/protocols.php and
 * inc/content/locations.php, so the page cannot claim a protocol or a
 * country the data files do not list.
 */

defined('NX') || exit;

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="page-hero">
  <div class="container">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('features.eyebrow'); ?></span>
      <h1><?php echo nx_e('features.title'); ?></h1>
      <p class="lead"><?php echo nx_e('features.subtitle'); ?></p>
    </div>
  </div>
</section>

<!-- ====================== Connection methods ==================== -->
<section class="section" id="protocols">
  <div class="container container--wide">
    <div class="section-head">
      <h2><?php echo nx_e('features.protocols.title'); ?></h2>
      <p><?php echo nx_e('features.protocols.body'); ?></p>
    </div>

    <div class="reveal">
      <?php require NX_INC . '/partials/protocol-table.php'; ?>
    </div>

    <div class="callout callout--info u-mt-lg">
      <?php echo nx_icon('info'); ?>
      <div>
        <p><?php echo nx_e('features.protocols.note'); ?></p>
      </div>
    </div>
  </div>
</section>

<!-- ========================== Failover ========================== -->
<section class="section section--band">
  <div class="container">
    <div class="split">
      <div class="split__body reveal">
        <h2><?php echo nx_e('features.failover.title'); ?></h2>
        <p><?php echo nx_e('features.failover.body'); ?></p>
      </div>

      <?php
      /* Drawn in CSS from the app's real behaviour: a route that stops
         responding, a switch to the next one, and -- the part that
         matters -- a verification step before the state is reported as
         connected. Decorative, so the whole figure carries one text
         alternative and its internals are hidden. */
      ?>
      <div class="split__media reveal" role="img"
           aria-label="<?php echo nx_e('features.failover.diagram_alt'); ?>">
        <div class="flow flow--stack" aria-hidden="true">
          <div class="flow__node flow__node--dead">
            <?php echo nx_icon('close'); ?>
            <span><?php echo nx_e('features.failover.step_blocked'); ?></span>
          </div>
          <div class="flow__link">
            <span class="flow__line"></span>
            <span class="flow__tag">
              <?php echo nx_icon('shuffle'); ?>
              <?php echo nx_e('features.failover.step_switch'); ?>
            </span>
          </div>
          <div class="flow__node">
            <?php echo nx_icon('shield-check'); ?>
            <span><?php echo nx_e('features.failover.step_verify'); ?></span>
          </div>
          <div class="flow__link">
            <span class="flow__line"></span>
          </div>
          <div class="flow__node flow__node--end">
            <?php echo nx_icon('check'); ?>
            <span><?php echo nx_e('features.failover.step_connected'); ?></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ======================== Split tunnel ======================== -->
<section class="section">
  <div class="container">
    <div class="split split--flip">
      <div class="split__body reveal">
        <h2><?php echo nx_e('features.split.title'); ?></h2>
        <p><?php echo nx_e('features.split.body'); ?></p>

        <div class="callout callout--warn u-mt-lg">
          <?php echo nx_icon('alert'); ?>
          <div>
            <p><?php echo nx_e('features.split.platforms'); ?></p>
          </div>
        </div>
      </div>

      <div class="split__media reveal">
        <div class="bento">
          <?php
          /* Named applications would be an endorsement and would date
             badly, so these are categories. */
          $nx_split_examples = array(
              'browser' => 'globe',
              'game'    => 'activity',
              'stream'  => 'monitor',
              'bank'    => 'lock',
          );
          foreach ($nx_split_examples as $nx_key => $nx_glyph): ?>
            <div class="bento__cell">
              <span class="bento__icon"><?php echo nx_icon($nx_glyph); ?></span>
              <h3><?php echo nx_e('features.split.example.' . $nx_key . '.title'); ?></h3>
              <p><?php echo nx_e('features.split.example.' . $nx_key . '.body'); ?></p>
            </div>
          <?php endforeach; ?>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ========================== Locations ========================= -->
<section class="section section--band" id="locations">
  <div class="container container--wide">
    <div class="section-head">
      <h2><?php echo nx_e('features.locations.title'); ?></h2>
      <p><?php echo nx_e('features.locations.body'); ?></p>
    </div>

    <div class="reveal">
      <?php require NX_INC . '/partials/locations-grid.php'; ?>
    </div>
  </div>
</section>

<!-- ============================ Relay =========================== -->
<section class="section">
  <div class="container">
    <div class="split">
      <div class="split__body reveal">
        <h2><?php echo nx_e('features.relay.title'); ?></h2>
        <p><?php echo nx_e('features.relay.body'); ?></p>
        <a class="section-link" href="<?php echo nx_esc(nx_url('pricing')); ?>">
          <?php echo nx_e('features.relay.link'); ?>
          <?php echo nx_icon('arrow-right'); ?>
        </a>
      </div>

      <div class="split__media reveal" role="img"
           aria-label="<?php echo nx_e('features.relay.diagram_alt'); ?>">
        <div class="flow" aria-hidden="true">
          <div class="flow__node">
            <?php echo nx_icon('smartphone'); ?>
            <span><?php echo nx_e('features.relay.you'); ?></span>
          </div>
          <div class="flow__link">
            <span class="flow__line"></span>
            <span class="flow__tag">
              <?php echo nx_icon('lock'); ?>
              <?php echo nx_e('home.security.diagram.tunnel'); ?>
            </span>
          </div>
          <div class="flow__node">
            <?php echo nx_icon('route'); ?>
            <span><?php echo nx_e('features.relay.entry'); ?></span>
          </div>
          <div class="flow__link">
            <span class="flow__line"></span>
          </div>
          <div class="flow__node flow__node--end">
            <?php echo nx_icon('server'); ?>
            <span><?php echo nx_e('features.relay.exit'); ?></span>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- ===================== Everything else ======================== -->
<section class="section section--band">
  <div class="container container--wide">
    <div class="section-head">
      <h2><?php echo nx_e('features.more.title'); ?></h2>
    </div>

    <div class="bento">
      <?php
      /* The wide cell first: DNS and IPv6 is the one most likely to be
         the reason a technical buyer chooses this over something else,
         and it is the one nobody else states plainly. */
      $nx_more = array(
          'dns'     => array('glyph' => 'shield-check', 'wide' => true),
          'usage'   => array('glyph' => 'chart', 'wide' => false),
          'support' => array('glyph' => 'message', 'wide' => false),
      );
      foreach ($nx_more as $nx_key => $nx_meta): ?>
        <article class="bento__cell<?php echo $nx_meta['wide'] ? ' bento__cell--wide' : ''; ?> reveal">
          <span class="bento__icon"><?php echo nx_icon($nx_meta['glyph']); ?></span>
          <h3><?php echo nx_e('features.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('features.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- =========================== Who uses ========================= -->
<section class="section">
  <div class="container">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('features.uses.eyebrow'); ?></span>
      <h2><?php echo nx_e('features.uses.title'); ?></h2>
      <p><?php echo nx_e('features.uses.body'); ?></p>
    </div>

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
