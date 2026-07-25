<?php
/**
 * The shared form pipeline used by both the contact form and the reseller
 * application: validate -> store -> notify.
 *
 * Storage happens BEFORE mail, and success is reported if either one worked.
 * That ordering is deliberate. neoxify.com has SPF and DMARC but no DKIM and
 * mail is already known to land in spam, so treating the sent email as the
 * record of a submission would mean quietly losing real reseller applications.
 * The file in data/ is the source of truth; the email is a notification.
 *
 * Forms work with JavaScript disabled. Every check here is server-side.
 */

defined('NX') || exit;

require_once NX_INC . '/security.php';

/**
 * Field definitions per form.
 *
 * type:     text | email | textarea | choice
 * required: whether an empty value is an error
 * max:      maximum length in characters
 * choices:  allowed values for type=choice
 */
function nx_form_schema($form)
{
    $schemas = array(

        'contact' => array(
            'name'    => array('type' => 'text',     'required' => true,  'max' => 80),
            'email'   => array('type' => 'email',    'required' => true,  'max' => 120),
            'subject' => array('type' => 'text',     'required' => true,  'max' => 120),
            'message' => array('type' => 'textarea', 'required' => true,  'max' => 4000, 'min' => 10),
        ),

        'reseller' => array(
            'name'       => array('type' => 'text',     'required' => true,  'max' => 80),
            'email'      => array('type' => 'email',    'required' => true,  'max' => 120),
            'telegram'   => array('type' => 'text',     'required' => false, 'max' => 80),
            'country'    => array('type' => 'text',     'required' => true,  'max' => 60),
            'audience'   => array('type' => 'choice',   'required' => true,
                                  'choices' => array('under_100', '100_1000', 'over_1000', 'not_sure')),
            'experience' => array('type' => 'textarea', 'required' => false, 'max' => 2000),
            'message'    => array('type' => 'textarea', 'required' => true,  'max' => 3000, 'min' => 20),
        ),
    );

    return isset($schemas[$form]) ? $schemas[$form] : array();
}

/**
 * Strip control characters that have no business in a submitted field.
 *
 * Newlines survive in textareas and are removed everywhere else -- which is
 * also what stops a name or subject being used to inject extra mail headers.
 *
 * @param string $value
 * @param bool   $allowNewlines
 * @return string
 */
function nx_clean($value, $allowNewlines = false)
{
    $value = (string) $value;
    $pattern = $allowNewlines ? '/[^\P{C}\n]+/u' : '/\p{C}+/u';
    $cleaned = preg_replace($pattern, '', $value);

    // preg_replace returns null on malformed UTF-8; fall back rather than
    // turning the field into an empty string the visitor can't explain.
    if ($cleaned === null) {
        $cleaned = preg_replace('/[\x00-\x1F\x7F]/', '', $value);
    }

    return trim($cleaned);
}

/**
 * Length in characters, not bytes -- Persian submissions are multi-byte and a
 * strlen() cap would reject perfectly reasonable messages.
 */
function nx_len($value)
{
    if (function_exists('mb_strlen')) {
        return mb_strlen($value, 'UTF-8');
    }
    // Counts UTF-8 sequences without mbstring installed.
    return strlen(preg_replace('/[\x80-\xBF]/', '', $value));
}

/**
 * Run a form through the whole pipeline.
 *
 * On success this redirects (POST/redirect/GET) so a refresh can't resubmit,
 * and never returns.
 *
 * @param string $form 'contact' or 'reseller'
 * @return array {sent: bool, errors: array<string,string>, values: array}
 */
function nx_form_process($form)
{
    $schema = nx_form_schema($form);
    $result = array(
        'sent'   => isset($_GET['sent']) && $_GET['sent'] === '1',
        'errors' => array(),
        'values' => array(),
    );

    if (!isset($_SERVER['REQUEST_METHOD']) || $_SERVER['REQUEST_METHOD'] !== 'POST') {
        return $result;
    }

    // Collect and clean first, so whatever happens next we can re-render the
    // form with the visitor's own words still in it.
    foreach ($schema as $field => $rules) {
        $raw = isset($_POST[$field]) ? $_POST[$field] : '';
        if (!is_string($raw)) {
            $raw = '';
        }
        $result['values'][$field] = nx_clean($raw, $rules['type'] === 'textarea');
    }

    // --- Bot checks, cheapest first -----------------------------------

    if (nx_honeypot_tripped()) {
        // Say nothing useful. A bot that learns why it failed adapts.
        $result['errors']['_form'] = nx_t('form.error.generic');
        return $result;
    }

    $token = isset($_POST['_token']) ? (string) $_POST['_token'] : '';
    $issued = nx_csrf_check($form, $token);
    if ($issued === false) {
        $result['errors']['_form'] = nx_t('form.error.expired');
        return $result;
    }

    if (time() - $issued < (int) nx_cfg('form_min_seconds', 3)) {
        $result['errors']['_form'] = nx_t('form.error.too_fast');
        return $result;
    }

    if (!nx_rate_limit_ok($form)) {
        $result['errors']['_form'] = nx_t('form.error.rate_limited');
        return $result;
    }

    // --- Field validation ---------------------------------------------

    foreach ($schema as $field => $rules) {
        $value = $result['values'][$field];

        if ($value === '') {
            if (!empty($rules['required'])) {
                $result['errors'][$field] = nx_t('form.error.required');
            }
            continue;
        }

        if (isset($rules['max']) && nx_len($value) > $rules['max']) {
            $result['errors'][$field] = nx_t('form.error.too_long', array('max' => $rules['max']));
            continue;
        }

        if (isset($rules['min']) && nx_len($value) < $rules['min']) {
            $result['errors'][$field] = nx_t('form.error.too_short', array('min' => $rules['min']));
            continue;
        }

        if ($rules['type'] === 'email' && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
            $result['errors'][$field] = nx_t('form.error.email');
            continue;
        }

        if ($rules['type'] === 'choice' && !in_array($value, $rules['choices'], true)) {
            $result['errors'][$field] = nx_t('form.error.required');
        }
    }

    if ($result['errors']) {
        return $result;
    }

    // --- Deliver -------------------------------------------------------

    $stored = nx_form_store($form, $result['values']);
    $mailed = nx_form_mail($form, $result['values']);

    if (!$stored && !$mailed) {
        // Both paths failed -- tell the truth and give them somewhere else to
        // go, rather than showing a success screen for a lost message.
        $result['errors']['_form'] = nx_t('form.error.delivery', array(
            'email' => nx_cfg('contact_email'),
        ));
        return $result;
    }

    header('Location: ' . nx_url($form) . '?sent=1', true, 303);
    exit;
}

/**
 * Append a submission to data/ as one JSON object per line.
 *
 * @return bool
 */
function nx_form_store($form, $values)
{
    $record = array(
        'at'      => gmdate('c'),
        'form'    => $form,
        'locale'  => nx_locale(),
        // Hashed, not raw: enough to recognise a repeat submitter or abuse
        // pattern, without this site keeping a log of visitors' addresses.
        'ip_hash' => substr(hash('sha256', nx_client_ip() . '|' . nx_secret()), 0, 16),
        'fields'  => $values,
    );

    $json = json_encode($record, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        return false;
    }

    return nx_guarded_append(NX_DATA . '/submissions-' . $form . '.php', $json);
}

/**
 * Email the submission.
 *
 * From: is always our own domain so SPF aligns; the submitter's address goes
 * in Reply-To, so replying from a mail client just works.
 *
 * @return bool whether the MTA accepted the message -- not whether it arrived
 */
function nx_form_mail($form, $values)
{
    if (!function_exists('mail')) {
        return false;
    }

    $to = (string) nx_cfg('mail_to');
    $fromAddress = (string) nx_cfg('mail_from');
    $fromName = (string) nx_cfg('mail_from_name');

    if ($to === '' || !filter_var($to, FILTER_VALIDATE_EMAIL)) {
        return false;
    }

    $label = $form === 'reseller' ? 'Reseller application' : 'Contact form';
    $subject = $label . ' - ' . $values['name'];

    $lines = array($label, str_repeat('=', strlen($label)), '');
    foreach ($values as $field => $value) {
        $lines[] = strtoupper(str_replace('_', ' ', $field)) . ':';
        $lines[] = $value === '' ? '(not provided)' : $value;
        $lines[] = '';
    }
    $lines[] = '---';
    $lines[] = 'Submitted ' . gmdate('Y-m-d H:i:s') . ' UTC from the ' . nx_locale() . ' site.';
    $lines[] = 'A copy is stored on the server in data/submissions-' . $form . '.php';
    $body = implode("\r\n", $lines);

    $headers = array(
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'From: ' . nx_mail_encode($fromName) . ' <' . $fromAddress . '>',
        'X-Mailer: Neoxify Website',
    );

    // Only trust the submitted address in Reply-To after it has passed
    // validation and contains no line breaks -- this is the one field an
    // attacker controls that reaches a mail header.
    $replyTo = isset($values['email']) ? $values['email'] : '';
    if (filter_var($replyTo, FILTER_VALIDATE_EMAIL) && strpbrk($replyTo, "\r\n") === false) {
        $headers[] = 'Reply-To: ' . $replyTo;
    }

    return @mail(
        $to,
        nx_mail_encode($subject),
        $body,
        implode("\r\n", $headers),
        '-f' . $fromAddress
    );
}

/**
 * RFC 2047 encode a header value so non-ASCII names and subjects survive.
 * Done by hand because mbstring is not guaranteed on shared hosting.
 */
function nx_mail_encode($text)
{
    $text = str_replace(array("\r", "\n"), '', $text);
    if (preg_match('//u', $text) && preg_match('/^[\x20-\x7E]*$/', $text)) {
        return $text;
    }
    return '=?UTF-8?B?' . base64_encode($text) . '?=';
}

/** Value to re-render in a field after a validation error. */
function nx_form_value($state, $field)
{
    return isset($state['values'][$field]) ? $state['values'][$field] : '';
}

/** Error message for a field, or '' if it is fine. */
function nx_form_error($state, $field)
{
    return isset($state['errors'][$field]) ? $state['errors'][$field] : '';
}
