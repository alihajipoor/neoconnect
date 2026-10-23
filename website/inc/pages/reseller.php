<?php
/**
 * Reseller application page, shared by /reseller/ and /fa/reseller/.
 *
 * Note what this page does NOT say: no wholesale price list, no stated
 * margin, no promised panel access. What a reseller receives has never been
 * decided, so inventing it here would be a commercial promise made on the
 * operator's behalf. Terms are agreed individually, which is true.
 *
 * Posts to itself (nx_form_url('reseller')); check-site.php asserts it.
 */

defined('NX') || exit;

require_once NX_INC . '/form.php';

// Before any output -- a successful submission redirects.
$nx_state = nx_form_process('reseller');

require NX_INC . '/partials/head.php';
require NX_INC . '/partials/form-fields.php';
?>

<section class="page-hero">
  <?php echo nx_world('page'); ?>
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('nav.reseller'); ?></span>
      <h1 class="h1"><?php echo nx_e('reseller.title'); ?></h1>
      <p class="lede"><?php echo nx_e('reseller.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top" aria-labelledby="h-about">
  <div class="wrap">
    <div class="callout callout--info u-mb-lg">
      <?php echo nx_icon('users'); ?>
      <div>
        <h2 class="callout__title" id="h-about"><?php echo nx_e('reseller.about.title'); ?></h2>
        <p><?php echo nx_e('reseller.about.body'); ?></p>
      </div>
    </div>

    <ol class="grid grid--3 u-list-reset u-mb-xl steps-cards">
      <?php for ($nx_i = 1; $nx_i <= 3; $nx_i++): ?>
        <li class="card feature reveal">
          <span class="ico" aria-hidden="true"><?php echo nx_num($nx_i); ?></span>
          <h3><?php echo nx_e('reseller.steps.' . $nx_i . '.title'); ?></h3>
          <p><?php echo nx_e('reseller.steps.' . $nx_i . '.body'); ?></p>
        </li>
      <?php endfor; ?>
    </ol>

    <div class="form-layout">
      <div class="form-card glass">
        <?php nx_form_status($nx_state, 'reseller.success.title', 'reseller.success.body'); ?>

        <?php if (empty($nx_state['sent'])): ?>
          <h2 class="form-card__title"><?php echo nx_e('reseller.form.title'); ?></h2>
          <?php
          nx_form_open('reseller');
          nx_field($nx_state, 'name', 'reseller.field.name', array('required' => true, 'autocomplete' => 'name'));
          nx_field($nx_state, 'email', 'reseller.field.email', array('type' => 'email', 'required' => true, 'autocomplete' => 'email'));
          nx_field($nx_state, 'telegram', 'reseller.field.telegram', array('hint' => 'reseller.field.telegram_hint'));
          nx_field($nx_state, 'country', 'reseller.field.country', array('required' => true, 'autocomplete' => 'country-name'));
          nx_field($nx_state, 'audience', 'reseller.field.audience', array(
              'type' => 'select', 'required' => true,
              'choices' => array(
                  'under_100' => 'reseller.audience.under_100',
                  '100_1000'  => 'reseller.audience.100_1000',
                  'over_1000' => 'reseller.audience.over_1000',
                  'not_sure'  => 'reseller.audience.not_sure',
              ),
          ));
          nx_field($nx_state, 'experience', 'reseller.field.experience', array(
              'type' => 'textarea', 'placeholder' => 'reseller.field.experience_placeholder', 'rows' => 4,
          ));
          nx_field($nx_state, 'message', 'reseller.field.message', array(
              'type' => 'textarea', 'required' => true,
              'placeholder' => 'reseller.field.message_placeholder', 'rows' => 6,
          ));
          nx_form_close('reseller.submit');
          ?>
        <?php endif; ?>
      </div>

      <div class="asides">
        <div class="card aside">
          <span class="ico"><?php echo nx_icon('mail'); ?></span>
          <h2><?php echo nx_e('contact.direct.title'); ?></h2>
          <p><?php
            $nx_email = (string) nx_cfg('contact_email');
            echo str_replace(':email', '<a href="mailto:' . nx_esc($nx_email) . '" data-ltr>' . nx_esc($nx_email) . '</a>', nx_e('contact.direct.body'));
          ?></p>
        </div>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
