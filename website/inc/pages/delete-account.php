<?php
/**
 * Account deletion request, shared by /delete-account/ and
 * /fa/delete-account/.
 *
 * Exists because Google Play requires a publicly reachable page where a
 * customer can request deletion without installing the app. The URL is
 * declared in the Play Console data safety form, so this page failing
 * quietly is expensive.
 *
 * THE FORM POSTS TO THIS PAGE -- /delete-account/ (or /fa/delete-account/)
 * -- through nx_form_url('deletion'). The form is called 'deletion' while
 * the route is 'delete-account'; when the two were assumed to match, every
 * request POSTed to the home page and was silently lost. check-site.php
 * asserts the rendered action on every build.
 *
 * The in-app route is offered first, because it is immediate and
 * self-service where this is neither.
 */

defined('NX') || exit;

require_once NX_INC . '/form.php';

// Before any output: a successful submission redirects.
$nx_state = nx_form_process('deletion');

require NX_INC . '/partials/head.php';
require NX_INC . '/partials/form-fields.php';
?>

<section class="page-hero">
  <?php echo nx_world('page'); ?>
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('nav.delete_account'); ?></span>
      <h1 class="h1"><?php echo nx_e('delete.title'); ?></h1>
      <p class="lede"><?php echo nx_e('delete.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top">
  <div class="wrap">
    <div class="form-layout">

      <div class="form-card glass">
        <?php nx_form_status($nx_state, 'delete.success.title', 'delete.success.body'); ?>

        <?php if (empty($nx_state['sent'])): ?>
          <h2 class="form-card__title"><?php echo nx_e('delete.inapp.title'); ?></h2>
          <p class="form-card__lead"><?php echo nx_e('delete.inapp.body'); ?></p>

          <p class="divider"><?php echo nx_e('delete.or'); ?></p>

          <h2 class="form-card__title"><?php echo nx_e('delete.form.title'); ?></h2>
          <p class="form-card__lead"><?php echo nx_e('delete.form.body'); ?></p>

          <?php
          nx_form_open('deletion');
          nx_field($nx_state, 'email', 'delete.field.email', array('required' => true, 'type' => 'email', 'autocomplete' => 'email'));
          nx_field($nx_state, 'message', 'delete.field.message', array('type' => 'textarea', 'rows' => 4));
          nx_form_close('delete.form.submit');
          ?>
        <?php endif; ?>
      </div>

      <div class="asides">
        <div class="card aside">
          <span class="ico"><?php echo nx_icon('file-off'); ?></span>
          <h2><?php echo nx_e('delete.what.title'); ?></h2>
          <p><?php echo nx_e('delete.what.body'); ?></p>
        </div>
        <div class="card aside">
          <span class="ico"><?php echo nx_icon('lock'); ?></span>
          <h2><?php echo nx_e('delete.kept.title'); ?></h2>
          <p><?php echo nx_e('delete.kept.body'); ?></p>
        </div>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
