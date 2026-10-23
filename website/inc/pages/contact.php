<?php
/**
 * Contact page, shared by /contact/ and /fa/contact/.
 *
 * Posts to itself (nx_form_url('contact') -> /contact/ or /fa/contact/);
 * inc/form.php validates, stores, then mails. scripts/check-site.php
 * asserts the form's action.
 */

defined('NX') || exit;

require_once NX_INC . '/form.php';

// Must run before any output: a successful submission redirects, and headers
// cannot be sent once the document has started.
$nx_state = nx_form_process('contact');

require NX_INC . '/partials/head.php';
require NX_INC . '/partials/form-fields.php';
?>

<section class="page-hero">
  <?php echo nx_world('page'); ?>
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('nav.contact'); ?></span>
      <h1 class="h1"><?php echo nx_e('contact.title'); ?></h1>
      <p class="lede"><?php echo nx_e('contact.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top">
  <div class="wrap">
    <div class="form-layout">

      <div class="form-card glass">
        <?php nx_form_status($nx_state, 'contact.success.title', 'contact.success.body'); ?>

        <?php if (empty($nx_state['sent'])): ?>
          <h2 class="form-card__title"><?php echo nx_e('contact.form.title'); ?></h2>
          <?php
          nx_form_open('contact');
          nx_field($nx_state, 'name', 'contact.field.name', array('required' => true, 'autocomplete' => 'name'));
          nx_field($nx_state, 'email', 'contact.field.email', array('type' => 'email', 'required' => true, 'autocomplete' => 'email'));
          nx_field($nx_state, 'subject', 'contact.field.subject', array('required' => true));
          nx_field($nx_state, 'message', 'contact.field.message', array(
              'type' => 'textarea', 'required' => true,
              'placeholder' => 'contact.field.message_placeholder', 'rows' => 7,
          ));
          nx_form_close('contact.submit');
          ?>
        <?php endif; ?>
      </div>

      <div class="asides">
        <div class="card aside">
          <span class="ico"><?php echo nx_icon('mail'); ?></span>
          <h2><?php echo nx_e('contact.direct.title'); ?></h2>
          <p><?php
            // The address is escaped into the link text and the href
            // separately -- never interpolated raw into markup.
            $nx_email = (string) nx_cfg('contact_email');
            echo str_replace(':email', '<a href="mailto:' . nx_esc($nx_email) . '" data-ltr>' . nx_esc($nx_email) . '</a>', nx_e('contact.direct.body'));
          ?></p>
        </div>

        <div class="card aside">
          <span class="ico"><?php echo nx_icon('message'); ?></span>
          <h2><?php echo nx_e('contact.support.title'); ?></h2>
          <p><?php echo nx_e('contact.support.body'); ?></p>
        </div>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
