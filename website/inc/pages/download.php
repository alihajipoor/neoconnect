<?php
/**
 * Download page, shared by /download/ and /fa/download/.
 *
 * Each platform card has two genuine states, driven by its configured
 * installer URL: a real download when one is set, and an honest "not out
 * yet" panel when it is not. There is deliberately no third state where we
 * show a button that 404s. Windows and Android are independent, because
 * they ship on their own schedules.
 *
 * The page holds no version number or release tag of its own. The configured
 * URL always resolves to the current release, and anything printed here
 * beside it could only go stale -- which is exactly what happened when this
 * page pinned a release tag.
 */

defined('NX') || exit;

$nx_available = nx_windows_available();
$nx_android = nx_android_available();

require NX_INC . '/partials/head.php';
?>

<section class="section download-hero">
  <div class="container">
    <div class="section-head">
      <h1><?php echo nx_e('download.title'); ?></h1>
      <p class="lead"><?php echo nx_e('download.subtitle'); ?></p>
    </div>

    <?php if (nx_beta()): ?>
      <?php /* Said before the download buttons rather than after. Somebody
               about to install should know what they are joining, and the
               request for feedback only makes sense if they read it first. */ ?>
      <div class="notice u-mb-md">
        <h3>
          <?php echo nx_icon('activity'); ?>
          <?php echo nx_e('beta.title'); ?>
        </h3>
        <p><?php echo nx_e('beta.body'); ?></p>
      </div>
    <?php endif; ?>
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
              <?php /* No version number here on purpose -- the link always
                       resolves to the current release, so a number printed
                       here could only ever be wrong. */ ?>
              <?php echo nx_e('download.windows.always_current'); ?>
              <?php if (nx_windows_checksum_url() !== ''): ?>
                &middot;
                <a href="<?php echo nx_esc(nx_windows_checksum_url()); ?>" rel="noopener">
                  <?php echo nx_e('download.windows.checksum'); ?>
                </a>
              <?php endif; ?>
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

        <?php if ($nx_android): ?>
          <div class="download-card u-mt-md">
            <div class="download-card__head">
              <span class="download-card__icon"><?php echo nx_icon('smartphone'); ?></span>
              <div>
                <h2 class="h-md"><?php echo nx_e('download.android.name'); ?></h2>
                <p class="download-card__meta">
                  <?php echo nx_e('download.android.requirements'); ?>
                </p>
              </div>
            </div>

            <a class="btn btn--primary btn--lg btn--block"
               href="<?php echo nx_esc(nx_android_download_url()); ?>">
              <?php echo nx_icon('download'); ?>
              <?php echo nx_e('download.android.button'); ?>
            </a>

            <p class="download-card__links">
              <?php echo nx_e('download.windows.always_current'); ?>
            </p>
          </div>

          <?php /* Said plainly rather than discovered at install time.
                   Android refuses an APK from a browser until the customer
                   allows it, and shows a warning while doing so -- somebody
                   who was not told that reasonably assumes the file is
                   suspect and stops. */ ?>
          <div class="notice notice--warn u-mt-md">
            <h3><?php echo nx_e('download.android.sideload.title'); ?></h3>
            <p><?php echo nx_e('download.android.sideload.body'); ?></p>
          </div>
        <?php endif; ?>

        <?php if ($nx_available): ?>
          <div class="notice u-mt-md">
            <h3>
              <?php echo nx_icon('refresh'); ?>
              <?php echo nx_e('download.autoupdate.title'); ?>
            </h3>
            <p><?php echo nx_e('download.autoupdate.body'); ?></p>
            <?php if ($nx_android): ?>
              <?php /* Android is the exception and the page says so. The
                       system will not let an app replace its own APK
                       without the customer confirming, so pretending it
                       updates itself would be a promise we cannot keep. */ ?>
              <p class="u-mt-xs"><?php echo nx_e('download.autoupdate.android'); ?></p>
            <?php endif; ?>
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

        <?php if ($nx_android): ?>
          <div class="notice u-mt-sm">
            <h3><?php echo nx_e('download.android.steps.title'); ?></h3>
            <ol class="steps-list u-mt-sm">
              <?php for ($nx_i = 1; $nx_i <= 4; $nx_i++): ?>
                <li><span><?php echo nx_e('download.android.steps.' . $nx_i); ?></span></li>
              <?php endfor; ?>
            </ol>
          </div>
        <?php endif; ?>

        <div class="notice u-mt-sm">
          <h3><?php echo nx_e('download.other.title'); ?></h3>
          <p><?php echo nx_e('download.other.body'); ?></p>

          <div class="platform-list">
            <?php
            /* Driven by config rather than hardcoded: this list and the
               cards above were two places that could disagree about
               whether a platform had shipped, and after Android shipped
               they did. */
            $nx_glyphs = array('macos' => 'laptop', 'android' => 'smartphone', 'ios' => 'smartphone');
            foreach (nx_cfg('platforms_planned', array()) as $nx_key):
                $nx_glyph = isset($nx_glyphs[$nx_key]) ? $nx_glyphs[$nx_key] : 'laptop'; ?>
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
