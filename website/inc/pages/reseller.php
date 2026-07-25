<?php
/**
 * Reseller application page, shared by /reseller/ and /fa/reseller/.
 *
 * Note what this page does NOT say: there is no wholesale price list, no
 * stated margin, no promised panel access. What a reseller actually receives
 * has never been decided, so inventing it here would be making a commercial
 * promise on the operator's behalf. The page says terms are agreed
 * individually, which is both true and what was actually asked for.
 */

defined('NX') || exit;

require_once NX_INC . '/form.php';

// Before any output -- a successful submission redirects.
$nx_state = nx_form_process('reseller');

require NX_INC . '/partials/head.php';
require NX_INC . '/partials/form-fields.php';
?>

<section class="section">
  <div class="container">
    <div class="section-head">
      <h1><?php echo nx_e('reseller.title'); ?></h1>
      <p class="lead"><?php echo nx_e('reseller.subtitle'); ?></p>
    </div>

    <div class="notice u-mb-lg">
      <h3><?php echo nx_e('reseller.about.title'); ?></h3>
      <p><?php echo nx_e('reseller.about.body'); ?></p>
    </div>

    <div class="grid grid--3 u-mb-xl">
      <?php for ($nx_i = 1; $nx_i <= 3; $nx_i++): ?>
        <div class="step reveal">
          <div class="step__num"><?php echo $nx_i; ?></div>
          <h3><?php echo nx_e('reseller.steps.' . $nx_i . '.title'); ?></h3>
          <p><?php echo nx_e('reseller.steps.' . $nx_i . '.body'); ?></p>
        </div>
      <?php endfor; ?>
    </div>

    <div class="form-layout">

      <div class="form-card">
        <?php nx_form_status($nx_state, 'reseller.success.title', 'reseller.success.body'); ?>

        <?php if (empty($nx_state['sent'])): ?>
          <h2 class="h-sm u-mb-md">
            <?php echo nx_e('reseller.form.title'); ?>
          </h2>

          <?php
          nx_form_open('reseller');

          nx_field($nx_state, 'name', 'reseller.field.name', array(
              'required' => true,
              'autocomplete' => 'name',
          ));

          nx_field($nx_state, 'email', 'reseller.field.email', array(
              'type' => 'email',
              'required' => true,
              'autocomplete' => 'email',
          ));

          nx_field($nx_state, 'telegram', 'reseller.field.telegram', array(
              'hint' => 'reseller.field.telegram_hint',
          ));

          nx_field($nx_state, 'country', 'reseller.field.country', array(
              'required' => true,
              'autocomplete' => 'country-name',
          ));

          nx_field($nx_state, 'audience', 'reseller.field.audience', array(
              'type' => 'select',
              'required' => true,
              'choices' => array(
                  'under_100' => 'reseller.audience.under_100',
                  '100_1000'  => 'reseller.audience.100_1000',
                  'over_1000' => 'reseller.audience.over_1000',
                  'not_sure'  => 'reseller.audience.not_sure',
              ),
          ));

          nx_field($nx_state, 'experience', 'reseller.field.experience', array(
              'type' => 'textarea',
              'placeholder' => 'reseller.field.experience_placeholder',
              'rows' => 4,
          ));

          nx_field($nx_state, 'message', 'reseller.field.message', array(
              'type' => 'textarea',
              'required' => true,
              'placeholder' => 'reseller.field.message_placeholder',
              'rows' => 6,
          ));

          nx_form_close('reseller.submit');
          ?>
        <?php endif; ?>
      </div>

      <div>
        <div class="aside-card">
          <div class="card__icon"><?php echo nx_icon('users'); ?></div>
          <h3><?php echo nx_e('reseller.steps.2.title'); ?></h3>
          <p><?php echo nx_e('reseller.steps.2.body'); ?></p>
        </div>

        <div class="aside-card">
          <h3><?php echo nx_e('contact.direct.title'); ?></h3>
          <p><?php
            $nx_email = (string) nx_cfg('contact_email');
            echo nx_t('contact.direct.body', array(
                'email' => '<a href="mailto:' . nx_esc($nx_email) . '">'
                    . nx_esc($nx_email) . '</a>',
            ));
          ?></p>
        </div>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
