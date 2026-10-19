<?php
/**
 * Features page, shared by /features/ and /fa/features/.
 *
 * The product's most distinctive thing -- several connection methods,
 * named -- gets a page of its own, with a title, a canonical and something
 * for a search engine to rank against "wireguard vpn" or "shadowsocks" and
 * their Persian equivalents.
 *
 * Everything here is driven by inc/content/protocols.php and
 * inc/content/locations.php, so the page cannot claim a protocol or a
 * country the data files do not list.
 */

defined('NX') || exit;

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="page-hero">
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('features.eyebrow'); ?></span>
      <h1 class="h1"><?php echo nx_e('features.title'); ?></h1>
      <p class="lede"><?php echo nx_e('features.subtitle'); ?></p>
    </div>
  </div>
</section>

<!-- ====================== Connection methods ==================== -->
<section class="section section--tight" id="protocols" aria-labelledby="h-protocols">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2" id="h-protocols"><?php echo nx_e('features.protocols.title'); ?></h2>
      <p class="lede"><?php echo nx_e('features.protocols.body'); ?></p>
    </div>

    <?php require NX_INC . '/partials/protocol-table.php'; ?>

    <div class="callout callout--info u-mt-md">
      <?php echo nx_icon('info'); ?>
      <p><?php echo nx_e('features.protocols.note'); ?></p>
    </div>
  </div>
</section>

<!-- ========================== Failover ========================== -->
<section class="section section--alt" aria-labelledby="h-failover">
  <div class="wrap">
    <div class="split">
      <div class="split__body reveal">
        <h2 class="h2" id="h-failover"><?php echo nx_e('features.failover.title'); ?></h2>
        <p class="body"><?php echo nx_e('features.failover.body'); ?></p>
      </div>

      <?php /* Drawn from the app's real behaviour: a route that stops
               responding, a switch to the next one, and -- the part that
               matters -- a verification step before the state is reported
               as connected. One text alternative; the parts are hidden. */ ?>
      <div class="flow flow--stack reveal" role="img" aria-label="<?php echo nx_e('features.failover.diagram_alt'); ?>">
        <div class="flow__node flow__node--dead" aria-hidden="true"><span class="ico"><?php echo nx_icon('close'); ?></span><span><?php echo nx_e('features.failover.step_blocked'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span><span class="flow__tag"><?php echo nx_icon('shuffle'); ?><?php echo nx_e('features.failover.step_switch'); ?></span></div>
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('shield-check'); ?></span><span><?php echo nx_e('features.failover.step_verify'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span></div>
        <div class="flow__node flow__node--ok" aria-hidden="true"><span class="ico"><?php echo nx_icon('check'); ?></span><span><?php echo nx_e('features.failover.step_connected'); ?></span></div>
      </div>
    </div>
  </div>
</section>

<!-- ======================== Split tunnel ======================== -->
<section class="section" aria-labelledby="h-split">
  <div class="wrap">
    <div class="split split--flip">
      <div class="split__body reveal">
        <h2 class="h2" id="h-split"><?php echo nx_e('features.split.title'); ?></h2>
        <p class="body"><?php echo nx_e('features.split.body'); ?></p>
        <div class="callout callout--warn">
          <?php echo nx_icon('alert'); ?>
          <p><?php echo nx_e('features.split.platforms'); ?></p>
        </div>
      </div>

      <div class="grid grid--2 reveal">
        <?php
        /* Named applications would be an endorsement and would date badly,
           so these are categories. */
        $nx_split_examples = array('browser' => 'globe', 'game' => 'activity', 'stream' => 'monitor', 'bank' => 'lock');
        foreach ($nx_split_examples as $nx_key => $nx_glyph): ?>
          <article class="card feature">
            <span class="ico"><?php echo nx_icon($nx_glyph); ?></span>
            <h3><?php echo nx_e('features.split.example.' . $nx_key . '.title'); ?></h3>
            <p><?php echo nx_e('features.split.example.' . $nx_key . '.body'); ?></p>
          </article>
        <?php endforeach; ?>
      </div>
    </div>
  </div>
</section>

<!-- ========================== Locations ========================= -->
<section class="section section--alt" id="locations" aria-labelledby="h-locations">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2" id="h-locations"><?php echo nx_e('features.locations.title'); ?></h2>
      <p class="lede"><?php echo nx_e('features.locations.body'); ?></p>
    </div>
    <?php require NX_INC . '/partials/locations-grid.php'; ?>
  </div>
</section>

<!-- ============================ Relay =========================== -->
<section class="section" aria-labelledby="h-relay">
  <div class="wrap">
    <div class="split">
      <div class="split__body reveal">
        <h2 class="h2" id="h-relay"><?php echo nx_e('features.relay.title'); ?></h2>
        <p class="body"><?php echo nx_e('features.relay.body'); ?></p>
        <p><a class="link" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('features.relay.link'); ?><?php echo nx_icon('arrow-right'); ?></a></p>
      </div>

      <div class="flow reveal" role="img" aria-label="<?php echo nx_e('features.relay.diagram_alt'); ?>">
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('smartphone'); ?></span><span><?php echo nx_e('features.relay.you'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span><span class="flow__tag"><?php echo nx_icon('lock'); ?><?php echo nx_e('home.security.diagram.tunnel'); ?></span></div>
        <div class="flow__node" aria-hidden="true"><span class="ico"><?php echo nx_icon('route'); ?></span><span><?php echo nx_e('features.relay.entry'); ?></span></div>
        <div class="flow__link" aria-hidden="true"><span class="flow__line"></span></div>
        <div class="flow__node flow__node--ok" aria-hidden="true"><span class="ico"><?php echo nx_icon('server'); ?></span><span><?php echo nx_e('features.relay.exit'); ?></span></div>
      </div>
    </div>
  </div>
</section>

<!-- ===================== Everything else ======================== -->
<section class="section section--alt" aria-labelledby="h-more">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2" id="h-more"><?php echo nx_e('features.more.title'); ?></h2>
    </div>

    <div class="grid grid--3">
      <?php
      /* DNS and IPv6 first: the one a technical buyer is most likely to
         choose on, and the one nobody else states plainly. */
      $nx_more = array('dns' => 'shield-check', 'usage' => 'chart', 'support' => 'message');
      foreach ($nx_more as $nx_key => $nx_glyph): ?>
        <article class="card feature reveal">
          <span class="ico"><?php echo nx_icon($nx_glyph); ?></span>
          <h3><?php echo nx_e('features.' . $nx_key . '.title'); ?></h3>
          <p><?php echo nx_e('features.' . $nx_key . '.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>
  </div>
</section>

<!-- =========================== Who uses ========================= -->
<section class="section" aria-labelledby="h-uses">
  <div class="wrap">
    <div class="section-head section-head--center">
      <span class="eyebrow"><?php echo nx_e('features.uses.eyebrow'); ?></span>
      <h2 class="h2" id="h-uses"><?php echo nx_e('features.uses.title'); ?></h2>
      <p class="lede"><?php echo nx_e('features.uses.body'); ?></p>
    </div>

    <?php require NX_INC . '/partials/cta-band.php'; ?>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
