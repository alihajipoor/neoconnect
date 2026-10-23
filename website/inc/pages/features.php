<?php
/**
 * Features page, shared by /features/ and /fa/features/.
 *
 * No protocol, port, transport, route or entry point is named here -- see
 * the note at the top of inc/pages/home.php. The locations are driven by
 * inc/content/locations.php, so the page cannot claim a country the data
 * file does not list.
 */

defined('NX') || exit;

require NX_INC . '/partials/head.php';
?>

<!-- ============================ Hero ============================ -->
<section class="page-hero">
  <?php echo nx_world('page'); ?>
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
  </div>
</section>

<!-- ========================== Failover ========================== -->
<section class="section section--alt" aria-labelledby="h-failover">
  <div class="wrap">
    <div class="split split--wide-art">
      <div class="split__body reveal">
        <h2 class="h2" id="h-failover"><?php echo nx_e('features.failover.title'); ?></h2>
        <p class="body"><?php echo nx_e('features.failover.body'); ?></p>
      </div>

      <?php /* The real Windows app, checking a connection before it says
               Connected (rendered from its preview, sample account; no method
               or route appears in the frame). */
            $nx_win = nx_locale() === 'fa' ? 'fa' : 'en'; ?>
      <figure class="appwin reveal">
        <span class="appwin__bar" aria-hidden="true"><i></i><i></i><i></i></span>
        <?php foreach (array('light', 'dark') as $nx_t): ?>
          <img class="only-<?php echo $nx_t; ?>" src="<?php echo nx_esc(nx_asset('img/story/desk-' . $nx_win . '-' . $nx_t . '-checking.webp')); ?>"
               width="944" height="608" loading="lazy" decoding="async" alt="<?php echo nx_e('features.failover.shot_alt'); ?>">
        <?php endforeach; ?>
        <figcaption class="appwin__note"><?php echo nx_e('features.failover.shot_note'); ?></figcaption>
      </figure>
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

<!-- ===================== The hardest networks ===================
     The plan difference, by what it is for. Never how it works, and no
     diagram: a drawing of the route is a map for a censor. -->
<section class="section" aria-labelledby="h-hardnet">
  <div class="wrap">
    <div class="section-head reveal">
      <h2 class="h2" id="h-hardnet"><?php echo nx_e('features.relay.title'); ?></h2>
      <p class="lede"><?php echo nx_e('features.relay.body'); ?></p>
    </div>
    <p><a class="link" href="<?php echo nx_esc(nx_url('pricing')); ?>"><?php echo nx_e('features.relay.link'); ?><?php echo nx_icon('arrow-right'); ?></a></p>
  </div>
</section>

<!-- ===================== Everything else ======================== -->
<section class="section section--alt" aria-labelledby="h-more">
  <div class="wrap">
    <div class="section-head">
      <h2 class="h2" id="h-more"><?php echo nx_e('features.more.title'); ?></h2>
    </div>

    <ul class="ledger ledger--cols u-list-reset">
      <?php
      /* DNS and IPv6 first: the one a technical buyer is most likely to
         choose on, and the one nobody else states plainly. */
      $nx_more = array('dns' => 'shield-check', 'usage' => 'chart', 'support' => 'message');
      foreach ($nx_more as $nx_key => $nx_glyph): ?>
        <li class="reveal">
          <span class="ico"><?php echo nx_icon($nx_glyph); ?></span>
          <div>
            <h3><?php echo nx_e('features.' . $nx_key . '.title'); ?></h3>
            <p><?php echo nx_e('features.' . $nx_key . '.body'); ?></p>
          </div>
        </li>
      <?php endforeach; ?>
    </ul>
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
