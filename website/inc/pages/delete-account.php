<?php
/**
 * Account deletion request, shared by /delete-account/ and /fa/delete-account/.
 *
 * Exists because Google Play requires a publicly reachable page where a
 * customer can request deletion without installing the app -- somebody who
 * has uninstalled, or who is reading this on a laptop, cannot use the
 * in-app control. The URL is declared in the Play Console data safety form.
 *
 * The in-app route is offered first and prominently, because it is
 * immediate and self-service where this is neither. Leading with the form
 * would push everyone down the slower path for no reason.
 */

defined('NX') || exit;

require_once NX_INC . '/form.php';

// Before any output: a successful submission redirects, and headers cannot
// be sent once the document has started.
$nx_state = nx_form_process('deletion');

require NX_INC . '/partials/head.php';
require NX_INC . '/partials/form-fields.php';
?>

<section class="section">
  <div class="container">
    <div class="section-head">
      <h1><?php echo nx_e('delete.title'); ?></h1>
      <p class="lead"><?php echo nx_e('delete.subtitle'); ?></p>
    </div>

    <div class="form-layout">

      <div class="form-card">
        <?php nx_form_status($nx_state, 'delete.success.title', 'delete.success.body'); ?>

        <?php if (empty($nx_state['sent'])): ?>
          <h2 class="h-sm u-mb-md"><?php echo nx_e('delete.inapp.title'); ?></h2>
          <p class="u-mb-md"><?php echo nx_e('delete.inapp.body'); ?></p>

          <hr class="u-mb-md">

          <h2 class="h-sm u-mb-md"><?php echo nx_e('delete.form.title'); ?></h2>
          <p class="u-mb-md"><?php echo nx_e('delete.form.body'); ?></p>

          <?php
          nx_form_open('deletion');

          nx_field($nx_state, 'email', 'delete.field.email', array(
              'required' => true,
              'type' => 'email',
              'autocomplete' => 'email',
          ));

          nx_field($nx_state, 'message', 'delete.field.message', array(
              'type' => 'textarea',
          ));

          nx_form_close('delete.form.submit');
          ?>
        <?php endif; ?>
      </div>

      <div>
        <div class="aside-card">
          <h3><?php echo nx_e('delete.what.title'); ?></h3>
          <p><?php echo nx_e('delete.what.body'); ?></p>
        </div>

        <div class="aside-card">
          <h3><?php echo nx_e('delete.kept.title'); ?></h3>
          <p><?php echo nx_e('delete.kept.body'); ?></p>
        </div>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
