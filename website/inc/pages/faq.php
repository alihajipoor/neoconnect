<?php
/**
 * FAQ page, shared by /faq/ and /fa/faq/.
 *
 * Its own page so it can carry FAQPage structured data -- one of the few
 * search features a small site can still win, because it depends on the
 * answer being useful rather than on domain authority.
 *
 * Questions come from inc/content/faq.php through nx_visible_faq(), the
 * same call the structured data uses, so the JSON-LD can never advertise a
 * question the page does not show.
 */

defined('NX') || exit;

$nx_faq = nx_visible_faq();

require NX_INC . '/partials/head.php';
?>

<section class="page-hero page-hero--center">
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('home.faq.eyebrow'); ?></span>
      <h1 class="h1"><?php echo nx_e('faq.title'); ?></h1>
      <p class="lede"><?php echo nx_e('faq.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top" aria-labelledby="h-questions">
  <div class="wrap wrap--prose">
    <h2 class="sr-only" id="h-questions"><?php echo nx_e('home.faq.title'); ?></h2>
    <div class="faq">
      <?php foreach ($nx_faq as $nx_item): ?>
        <details>
          <summary><?php echo nx_esc(nx_pick($nx_item['q'])); ?></summary>
          <div class="faq__answer"><p><?php echo nx_esc(nx_pick($nx_item['a'])); ?></p></div>
        </details>
      <?php endforeach; ?>
    </div>

    <div class="callout u-mt-lg">
      <?php echo nx_icon('message'); ?>
      <div>
        <p class="callout__title"><?php echo nx_e('faq.still.title'); ?></p>
        <p><?php echo nx_e('faq.still.body'); ?></p>
        <p class="u-mt-sm"><a class="btn btn--primary btn--sm" href="<?php echo nx_esc(nx_url('contact')); ?>"><?php echo nx_e('nav.contact'); ?></a></p>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
