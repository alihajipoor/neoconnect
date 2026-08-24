<?php
/**
 * Download page, shared by /download/ and /fa/download/.
 *
 * Laid out as a grid of platform tiles, because that is what someone arriving
 * here is looking for: their own platform, and a button. Each tile is either
 * genuinely downloadable or plainly marked as not built yet -- there is no
 * state where a button appears that cannot work.
 *
 * Availability comes from config (windows_installer_url, android_installer_url
 * and platforms_planned), so a platform shipping is a config change here, not
 * an edit in three places that can disagree with each other.
 *
 * The page holds no version numbers. The configured URLs always resolve to
 * the current release, and a number printed beside a rolling link can only go
 * stale -- which is exactly what happened when this page pinned a release tag.
 */

defined('NX') || exit;

$nx_available = nx_windows_available();
$nx_android = nx_android_available();
$nx_planned = nx_cfg('platforms_planned', array());

require NX_INC . '/partials/head.php';
?>

<section class="section download-hero">
  <div class="container">
    <div class="section-head">
      <h1><?php echo nx_e('download.title'); ?></h1>
      <p class="lead"><?php echo nx_e('download.subtitle'); ?></p>
    </div>

    <?php if (nx_beta()): ?>
      <?php /* Before the buttons, not after. Someone about to install should
               know what they are joining, and the request for feedback only
               works if they have read it first. */ ?>
      <div class="notice u-mb-md">
        <h2>
          <?php echo nx_icon('activity'); ?>
          <?php echo nx_e('beta.title'); ?>
        </h2>
        <p><?php echo nx_e('beta.body'); ?></p>
      </div>
    <?php endif; ?>
  </div>
</section>

<section class="section section--tight u-flush-top">
  <div class="container">

    <!-- ======================= Platform tiles ======================= -->
    <div class="platform-grid">

      <!-- Windows -->
      <article class="platform-tile<?php echo $nx_available ? ' platform-tile--ready' : ''; ?>">
        <span class="platform-tile__glyph"><?php echo nx_platform_icon('windows'); ?></span>
        <h2 class="platform-tile__name"><?php echo nx_e('download.windows.name'); ?></h2>

        <?php if ($nx_available): ?>
          <p class="platform-tile__meta"><?php echo nx_e('download.windows.requirements'); ?></p>
          <a class="btn btn--primary btn--block platform-tile__cta"
             href="<?php echo nx_esc(nx_windows_download_url()); ?>">
            <?php echo nx_icon('download'); ?>
            <?php echo nx_e('download.windows.button'); ?>
          </a>
          <p class="platform-tile__note">
            <?php echo nx_e('download.windows.always_current'); ?>
            <?php if (nx_windows_checksum_url() !== ''): ?>
              &middot;
              <a href="<?php echo nx_esc(nx_windows_checksum_url()); ?>" rel="noopener">
                <?php echo nx_e('download.windows.checksum'); ?>
              </a>
            <?php endif; ?>
          </p>
        <?php else: ?>
          <span class="badge-soon"><?php echo nx_e('download.unreleased.badge'); ?></span>
          <p class="platform-tile__meta"><?php echo nx_e('download.unreleased.body'); ?></p>
          <a class="btn btn--ghost btn--block platform-tile__cta"
             href="<?php echo nx_esc(nx_url('contact')); ?>">
            <?php echo nx_icon('mail'); ?>
            <?php echo nx_e('download.unreleased.cta'); ?>
          </a>
        <?php endif; ?>
      </article>

      <!-- Android -->
      <?php if ($nx_android): ?>
        <article class="platform-tile platform-tile--ready">
          <span class="platform-tile__glyph"><?php echo nx_platform_icon('android'); ?></span>
          <h2 class="platform-tile__name"><?php echo nx_e('download.android.name'); ?></h2>
          <p class="platform-tile__meta"><?php echo nx_e('download.android.requirements'); ?></p>
          <a class="btn btn--primary btn--block platform-tile__cta"
             href="<?php echo nx_esc(nx_android_download_url()); ?>">
            <?php echo nx_icon('download'); ?>
            <?php echo nx_e('download.android.button'); ?>
          </a>
          <p class="platform-tile__note"><?php echo nx_e('download.windows.always_current'); ?></p>
        </article>
      <?php endif; ?>

      <!-- Not built yet. Driven by config so this list and the tiles above
           cannot disagree about whether something has shipped. -->
      <?php
      $nx_platform_glyphs = array('macos' => 'apple', 'ios' => 'apple', 'android' => 'android');
      foreach ($nx_planned as $nx_key):
          $nx_glyph = isset($nx_platform_glyphs[$nx_key]) ? $nx_platform_glyphs[$nx_key] : 'apple'; ?>
        <article class="platform-tile platform-tile--soon">
          <span class="platform-tile__glyph"><?php echo nx_platform_icon($nx_glyph); ?></span>
          <h2 class="platform-tile__name"><?php echo nx_e('download.other.' . $nx_key); ?></h2>
          <span class="badge-soon"><?php echo nx_e('download.other.status'); ?></span>
          <p class="platform-tile__meta"><?php echo nx_e('download.other.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>

    <!-- ========================== Guidance ========================== -->
    <div class="download-main u-mt-lg">

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
      </div>

      <div>
        <?php if ($nx_available): ?>
          <div class="notice">
            <h3>
              <?php echo nx_icon('refresh'); ?>
              <?php echo nx_e('download.autoupdate.title'); ?>
            </h3>
            <p><?php echo nx_e('download.autoupdate.body'); ?></p>
            <?php if ($nx_android): ?>
              <?php /* Android is the exception and the page says so: the
                       system will not let an app replace its own installer
                       without the customer confirming, so claiming it updates
                       itself would be a promise we cannot keep. */ ?>
              <p class="u-mt-sm"><?php echo nx_e('download.autoupdate.android'); ?></p>
            <?php endif; ?>
          </div>
        <?php endif; ?>

        <?php if ($nx_android): ?>
          <?php /* Said plainly rather than discovered at install time. Android
                   refuses an APK from a browser until the customer allows it,
                   and warns while doing so -- somebody who was not told that
                   reasonably assumes the file is suspect and stops. */ ?>
          <div class="notice notice--warn u-mt-sm">
            <h3><?php echo nx_e('download.android.sideload.title'); ?></h3>
            <p><?php echo nx_e('download.android.sideload.body'); ?></p>
          </div>
        <?php endif; ?>

        <?php if (nx_cfg('windows_unsigned', true)): ?>
          <div class="notice notice--warn u-mt-sm">
            <h3><?php echo nx_e('download.unsigned.title'); ?></h3>
            <p><?php echo nx_e('download.unsigned.body'); ?></p>
          </div>
        <?php endif; ?>
      </div>

    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
