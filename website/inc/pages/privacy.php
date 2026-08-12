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

<section class="section">
  <div class="container">

    <div class="section-head">
      <h1><?php echo nx_e('privacy.title'); ?></h1>
      <p class="lead"><?php echo nx_e('privacy.subtitle'); ?></p>
      <?php if ($nx_updated !== ''): ?>
        <p class="privacy__updated">
          <?php echo nx_e('privacy.updated', array(
              // Rendered from the ISO date in the content file so the two can
              // never drift apart, in the locale's own format.
              'date' => date(nx_t('privacy.date_format'), strtotime($nx_updated)),
          )); ?>
        </p>
      <?php endif; ?>
    </div>

    <div class="prose">
      <?php foreach ($nx_privacy['sections'] as $nx_section): ?>
        <h2><?php echo nx_esc(nx_pick($nx_section['title'])); ?></h2>

        <?php foreach (nx_pick_list($nx_section, 'body') as $nx_para): ?>
          <p><?php echo nx_esc($nx_para); ?></p>
        <?php endforeach; ?>

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
        echo nx_t('privacy.contact.body', array(
            'email' => '<a href="mailto:' . nx_esc($nx_email) . '">' . nx_esc($nx_email) . '</a>',
        ));
      ?></p>
    </div>

  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
