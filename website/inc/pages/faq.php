<?php
/**
 * FAQ page, shared by /faq/ and /fa/faq/.
 *
 * New in the 2026-08 rebuild. The FAQ previously existed only as a block
 * on the home page, so it could not carry FAQPage structured data of its
 * own -- and FAQ rich results are one of the few SERP features a small
 * site can still win, because they depend on the answer being genuinely
 * useful rather than on domain authority.
 *
 * Questions come from inc/content/faq.php and are filtered through
 * nx_visible_faq(), the same call the structured data uses, so the JSON-LD
 * can never advertise a question the page does not show.
 */

defined('NX') || exit;

$nx_faq = nx_visible_faq();

require NX_INC . '/partials/head.php';
?>

<section class="page-hero page-hero--center">
  <div class="container">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h1><?php echo nx_e('faq.title'); ?></h1>
      <p class="lead"><?php echo nx_e('faq.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section">
  <div class="container container--prose">
    <div class="faq">
      <?php foreach ($nx_faq as $nx_item): ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><?php echo nx_esc(nx_pick($nx_item['a'])); ?></div>
        </details>
      <?php endforeach; ?>
    </div>

    <div class="callout u-mt-xl">
      <?php echo nx_icon('message'); ?>
      <div>
        <p class="callout__title"><?php echo nx_e('faq.still.title'); ?></p>
        <p><?php echo nx_e('faq.still.body'); ?></p>
      </div>
    </div>

    <p class="u-center u-mt-lg">
      <a class="btn btn--primary" href="<?php echo nx_esc(nx_url('contact')); ?>">
        <?php echo nx_e('nav.contact'); ?>
      </a>
    </p>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
