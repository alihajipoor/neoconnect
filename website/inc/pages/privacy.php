<?php
/**
 * Privacy statement, shared by /privacy/ and /fa/privacy/.
 *
 * The text lives in inc/content/privacy.php, per locale, so the document can
 * be edited in one place without touching this layout.
 */

defined('NX') || exit;

$nx_privacy = nx_content('privacy');
$nx_updated = isset($nx_privacy['updated']) ? $nx_privacy['updated'] : '';

require NX_INC . '/partials/head.php';
?>

<section class="page-hero">
  <?php echo nx_world('page'); ?>
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('nav.privacy'); ?></span>
      <h1 class="h1"><?php echo nx_e('privacy.title'); ?></h1>
      <p class="lede"><?php echo nx_e('privacy.subtitle'); ?></p>
      <?php if ($nx_updated !== ''): ?>
        <p class="updated"><?php echo nx_e('privacy.updated', array(
            // Rendered from the ISO date in the content file, in the
            // locale's own format, so the two can never drift apart.
            'date' => nx_num(date(nx_t('privacy.date_format'), strtotime($nx_updated))),
        )); ?></p>
      <?php endif; ?>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top">
  <div class="wrap">
    <article class="card prose">
      <?php foreach ($nx_privacy['sections'] as $nx_section): ?>
        <h2<?php echo isset($nx_section['id']) ? ' id="' . nx_esc($nx_section['id']) . '"' : ''; ?>><?php echo nx_esc(nx_pick($nx_section['title'])); ?></h2>
        <?php foreach (nx_pick_list($nx_section, 'body') as $nx_para): ?>
          <p><?php echo nx_esc($nx_para); ?></p>
        <?php endforeach; ?>
        <?php if (!empty($nx_section['ads_off_link'])): ?>
          <?php /* A plain link, so it works from any page and needs no
                   script on this one for anyone else. The request it makes
                   runs assets/js/ads.js, which records the "no" and deletes
                   the cookies; the line below is shown only once it has. */ ?>
          <p><a href="<?php echo nx_esc(nx_url('privacy') . '?ads=off#ads'); ?>"><?php echo nx_e('privacy.ads_off.link'); ?></a></p>
          <?php if (nx_ads_mode() === 'off'): ?>
            <p class="ads-done" data-ads-off-done hidden><?php echo nx_e('privacy.ads_off.done'); ?></p>
          <?php endif; ?>
        <?php endif; ?>
        <?php $nx_bullets = nx_pick_list($nx_section, 'bullets'); ?>
        <?php if ($nx_bullets): ?>
          <ul>
            <?php foreach ($nx_bullets as $nx_bullet): ?>
              <li><?php echo nx_esc($nx_bullet); ?></li>
            <?php endforeach; ?>
          </ul>
        <?php endif; ?>
      <?php endforeach; ?>

      <h2><?php echo nx_e('privacy.contact.title'); ?></h2>
      <p><?php
        $nx_email = (string) nx_cfg('contact_email');
        echo str_replace(':email', '<a href="mailto:' . nx_esc($nx_email) . '" data-ltr>' . nx_esc($nx_email) . '</a>', nx_e('privacy.contact.body'));
      ?></p>
    </article>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
