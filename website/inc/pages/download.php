<?php
/**
 * Download page, shared by /download/ and /fa/download/.
 *
 * The Windows card has two genuine states, driven by config's
 * windows_release_tag: a real download when a release has actually been
 * published, and an honest "not out yet" panel when it has not. There is
 * deliberately no third state where we show a button that 404s.
 */

defined('NX') || exit;

$nx_available = nx_windows_available();

require NX_INC . '/partials/head.php';
?>

<section class="section download-hero">
  <div class="container">
    <div class="section-head">
      <h1><?php echo nx_e('download.title'); ?></h1>
      <p class="lead"><?php echo nx_e('download.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight u-flush-top">
  <div class="container">
    <div class="download-main">

      <div>
        <div class="download-card">
          <div class="download-card__head">
            <span class="download-card__icon"><?php echo nx_icon('monitor'); ?></span>
            <div>
              <h2 class="h-md"><?php echo nx_e('download.windows.name'); ?></h2>
              <p class="download-card__meta">
                <?php echo nx_e('download.windows.requirements'); ?>
              </p>
            </div>
            <?php if (!$nx_available): ?>
              <span class="badge-soon u-push-end">
                <?php echo nx_e('download.unreleased.badge'); ?>
              </span>
            <?php endif; ?>
          </div>

          <?php if ($nx_available): ?>

            <a class="btn btn--primary btn--lg btn--block"
               href="<?php echo nx_esc(nx_windows_download_url()); ?>">
              <?php echo nx_icon('download'); ?>
              <?php echo nx_e('download.windows.button'); ?>
            </a>

            <p class="download-card__links">
              <?php echo nx_e('download.windows.version', array(
                  'version' => nx_cfg('windows_version'))); ?>
              &middot;
              <a href="<?php echo nx_esc(nx_windows_checksum_url()); ?>" rel="noopener">
                <?php echo nx_e('download.windows.checksum'); ?>
              </a>
            </p>

          <?php else: ?>

            <h3 class="h-xs u-mb-xs">
              <?php echo nx_e('download.unreleased.title'); ?>
            </h3>
            <p class="text-body">
              <?php echo nx_e('download.unreleased.body'); ?>
            </p>
            <a class="btn btn--ghost btn--block u-mt-md"
               href="<?php echo nx_esc(nx_url('contact')); ?>">
              <?php echo nx_icon('mail'); ?>
              <?php echo nx_e('download.unreleased.cta'); ?>
            </a>

          <?php endif; ?>
        </div>

        <?php if ($nx_available): ?>
          <div class="notice u-mt-md">
            <h3>
              <?php echo nx_icon('refresh'); ?>
              <?php echo nx_e('download.autoupdate.title'); ?>
            </h3>
            <p><?php echo nx_e('download.autoupdate.body'); ?></p>
          </div>
        <?php endif; ?>

        <?php if (nx_cfg('windows_unsigned', true)): ?>
          <div class="notice notice--warn u-mt-md">
            <h3><?php echo nx_e('download.unsigned.title'); ?></h3>
            <p><?php echo nx_e('download.unsigned.body'); ?></p>
          </div>
        <?php endif; ?>
      </div>

      <div>
        <div class="notice">
          <h3><?php echo nx_e('download.steps.title'); ?></h3>
          <ol class="steps-list u-mt-sm">
            <?php for ($nx_i = 1; $nx_i <= 4; $nx_i++): ?>
              <li><span><?php echo nx_e('download.steps.' . $nx_i); ?></span></li>
            <?php endfor; ?>
          </ol>
        </div>

        <div class="notice u-mt-sm">
          <h3><?php echo nx_e('download.other.title'); ?></h3>
          <p><?php echo nx_e('download.other.body'); ?></p>

          <div class="platform-list">
            <?php
            $nx_others = array(
                'macos'   => 'laptop',
                'android' => 'smartphone',
                'ios'     => 'smartphone',
            );
            foreach ($nx_others as $nx_key => $nx_glyph): ?>
              <div class="platform-row">
                <?php echo nx_icon($nx_glyph); ?>
                <span><?php echo nx_e('download.other.' . $nx_key); ?></span>
                <span class="platform-row__status">
                  <?php echo nx_e('download.other.status'); ?>
                </span>
              </div>
            <?php endforeach; ?>
          </div>
        </div>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
