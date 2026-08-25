<?php
/**
 * Form field rendering, shared by the contact and reseller forms so the two
 * cannot drift apart in markup, accessibility or error handling.
 *
 * Every field re-renders the visitor's own submitted value after a validation
 * error. Losing what someone typed because one field was wrong is the fastest
 * way to lose the submission entirely.
 */

defined('NX') || exit;

/**
 * Render one field.
 *
 * @param array  $state    the array returned by nx_form_process()
 * @param string $name     field name, matching inc/form.php's schema
 * @param string $labelKey translation key for the label
 * @param array  $opts     type, required, hint, placeholder, choices,
 *                         autocomplete, rows
 */
function nx_field($state, $name, $labelKey, $opts = array())
{
    $type = isset($opts['type']) ? $opts['type'] : 'text';
    $required = !empty($opts['required']);
    $value = nx_form_value($state, $name);
    $error = nx_form_error($state, $name);

    $id = 'f-' . $name;
    $hintId = $id . '-hint';
    $errorId = $id . '-error';

    // Point aria-describedby at whichever of hint/error actually exist, so a
    // screen reader never chases an id that isn't on the page.
    $described = array();
    if (!empty($opts['hint'])) {
        $described[] = $hintId;
    }
    if ($error !== '') {
        $described[] = $errorId;
    }
    $describedAttr = $described
        ? ' aria-describedby="' . implode(' ', $described) . '"'
        : '';

    $common = ' id="' . $id . '" name="' . nx_esc($name) . '"'
        . ($required ? ' required' : '')
        . ($error !== '' ? ' aria-invalid="true"' : '')
        . (isset($opts['autocomplete']) ? ' autocomplete="' . nx_esc($opts['autocomplete']) . '"' : '')
        . $describedAttr;

    echo '<div class="field' . ($error !== '' ? ' field--error' : '') . '">';

    echo '<label class="field__label" for="' . $id . '">'
        . '<span>' . nx_e($labelKey) . '</span>'
        . '<span class="field__flag">'
        . nx_e($required ? 'form.required' : 'form.optional')
        . '</span></label>';

    if ($type === 'textarea') {
        echo '<textarea class="textarea"' . $common
            . ' rows="' . (isset($opts['rows']) ? (int) $opts['rows'] : 6) . '"'
            . (isset($opts['placeholder'])
                ? ' placeholder="' . nx_e($opts['placeholder']) . '"' : '')
            . '>' . nx_esc($value) . '</textarea>';

    } elseif ($type === 'select') {
        echo '<div class="select-wrap"><select class="select"' . $common . '>';
        echo '<option value="">' . nx_e('form.choose') . '</option>';

        foreach ($opts['choices'] as $choiceValue => $choiceLabelKey) {
            echo '<option value="' . nx_esc($choiceValue) . '"'
                . ($value === (string) $choiceValue ? ' selected' : '') . '>'
                . nx_e($choiceLabelKey) . '</option>';
        }
        echo '</select></div>';

    } else {
        echo '<input class="input" type="' . nx_esc($type) . '"' . $common
            . ' value="' . nx_esc($value) . '"'
            . (isset($opts['placeholder'])
                ? ' placeholder="' . nx_e($opts['placeholder']) . '"' : '')
            . '>';
    }

    if (!empty($opts['hint'])) {
        echo '<p class="field__hint" id="' . $hintId . '">' . nx_e($opts['hint']) . '</p>';
    }

    if ($error !== '') {
        echo '<p class="field__error" id="' . $errorId . '">' . nx_esc($error) . '</p>';
    }

    echo '</div>';
}

/**
 * Open a form, including the CSRF token and the honeypot.
 *
 * @param string $form form name, must match what nx_form_process() was given
 */
function nx_form_open($form)
{
    /* nx_form_url(), never nx_url($form). A form name is not a route key --
       'deletion' is served from the page registered as 'delete-account' --
       and nx_url() silently falls back to the home page for anything it does
       not recognise. See nx_form_page() in inc/form.php. */
    echo '<form method="post" action="' . nx_esc(nx_form_url($form)) . '" data-form="'
        . nx_esc($form) . '" novalidate>';

    echo '<input type="hidden" name="_token" value="'
        . nx_esc(nx_csrf_token($form)) . '">';

    // Off-screen rather than hidden, so a bot parsing the DOM still finds it.
    // tabindex="-1" and aria-hidden keep it away from real keyboard users.
    echo '<div class="honeypot" aria-hidden="true">'
        . '<label for="f-' . NX_HONEYPOT_FIELD . '">' . nx_e('form.honeypot') . '</label>'
        . '<input type="text" id="f-' . NX_HONEYPOT_FIELD . '" name="'
        . NX_HONEYPOT_FIELD . '" tabindex="-1" autocomplete="off">'
        . '</div>';
}

/**
 * Render the submit button and close the form.
 *
 * @param string $labelKey
 */
function nx_form_close($labelKey)
{
    echo '<button type="submit" class="btn btn--primary btn--lg btn--block" '
        . 'data-submit data-busy-label="' . nx_e('form.sending') . '">'
        . nx_e($labelKey) . '</button>';
    echo '</form>';
}

/**
 * Success banner, or the form-level error, whichever applies.
 *
 * @param array  $state
 * @param string $titleKey success heading
 * @param string $bodyKey  success body
 */
function nx_form_status($state, $titleKey, $bodyKey)
{
    if (!empty($state['sent'])) {
        echo '<div class="alert alert--success" role="status">'
            . '<h3>' . nx_e($titleKey) . '</h3>'
            . '<p>' . nx_e($bodyKey) . '</p></div>';
        return;
    }

    $formError = nx_form_error($state, '_form');
    if ($formError !== '') {
        echo '<div class="alert alert--error" role="alert">'
            . nx_esc($formError) . '</div>';
        return;
    }

    if (!empty($state['errors'])) {
        echo '<div class="alert alert--error" role="alert">'
            . nx_e('form.has_errors') . '</div>';
    }
}
