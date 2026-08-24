<?php
/**
 * The connection-method table, shared by the features page and anywhere
 * else that needs the full list.
 *
 * A real <table> because it is real tabular data: eight methods against two
 * platforms. Below 55rem the stylesheet turns it into a stack of cards
 * using data-label attributes, so there is one set of markup rather than a
 * table plus a duplicated mobile card list that drift apart.
 *
 * Renders nothing at all if inc/content/protocols.php is emptied -- which
 * is the documented way to take the protocol names back off the site.
 */

defined('NX') || exit;

$nx_protocols = nx_protocols();
if (!$nx_protocols) {
    return;
}
?>
<div class="table-wrap">
  <table class="proto-table">
    <caption class="sr-only"><?php echo nx_e('features.protocols.title'); ?></caption>
    <thead>
      <tr>
        <th scope="col"><?php echo nx_e('features.protocols.table.method'); ?></th>
        <th scope="col"><?php echo nx_e('features.protocols.table.what'); ?></th>
        <th scope="col"><?php echo nx_e('features.protocols.table.windows'); ?></th>
        <th scope="col"><?php echo nx_e('features.protocols.table.android'); ?></th>
      </tr>
    </thead>
    <tbody>
      <?php foreach ($nx_protocols as $nx_p): ?>
        <tr>
          <th scope="row">
            <span class="proto__name"><?php echo nx_esc(nx_pick($nx_p['label'])); ?></span>
            <?php /* The underlying technology, always left-to-right: these
                     are Latin proper nouns and an RTL context moves the plus
                     sign to the wrong side of "VLESS + REALITY". */ ?>
            <span class="proto__tech" dir="ltr"><?php echo nx_esc($nx_p['tech']); ?></span>
          </th>
          <td class="proto__hint"><?php echo nx_esc(nx_pick($nx_p['hint'])); ?></td>

          <?php
          /* Two platform cells, built by a tiny loop rather than written
             twice -- the pair differ only in which key they read, and the
             one thing that must never happen here is the Windows column
             claiming Android's support or the reverse. */
          $nx_cols = array(
              'windows' => 'features.protocols.table.windows',
              'android' => 'features.protocols.table.android',
          );
          foreach ($nx_cols as $nx_key => $nx_label_key):
              $nx_ok = !empty($nx_p[$nx_key]);
          ?>
            <td data-label="<?php echo nx_e($nx_label_key); ?>">
              <span class="<?php echo $nx_ok ? 'proto__yes' : 'proto__no'; ?>">
                <?php echo $nx_ok ? nx_icon('check') : nx_icon('minus'); ?>
              </span>
              <?php /* The glyph alone is not an accessible answer -- a
                       screen reader would announce an empty span. */ ?>
              <span class="sr-only">
                <?php echo $nx_ok ? nx_e('common.yes') : nx_e('common.no'); ?>
              </span>
            </td>
          <?php endforeach; ?>
        </tr>
      <?php endforeach; ?>
    </tbody>
  </table>
</div>
