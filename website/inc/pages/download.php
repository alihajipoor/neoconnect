<?php
/**
 * Download page, shared by /download/ and /fa/download/.
 *
 * A grid of platform tiles, because that is what someone arriving here is
 * looking for: their own platform, and a button. Each tile is either
 * genuinely downloadable or plainly marked as not built yet -- there is no
 * state where a button appears that cannot work.
 *
 * Availability comes from config (windows_installer_url,
 * android_installer_url and platforms_planned), so a platform shipping is a
 * config change, not an edit in three places that can disagree.
 *
 * The page holds no version numbers. The configured URLs always resolve to
 * the current release, and a number printed beside a rolling link can only
 * go stale -- which is exactly what happened when this page pinned a tag.
 */

defined('NX') || exit;

$nx_available = nx_windows_available();
$nx_android = nx_android_available();
$nx_planned = nx_cfg('platforms_planned', array());

require NX_INC . '/partials/head.php';
?>

<section class="page-hero">
  <?php echo nx_world('page'); ?>
  <div class="wrap">
    <div class="page-hero__inner">
      <span class="eyebrow"><?php echo nx_e('nav.download'); ?></span>
      <h1 class="h1"><?php echo nx_e('download.title'); ?></h1>
      <p class="lede"><?php echo nx_e('download.subtitle'); ?></p>
    </div>
  </div>
</section>

<section class="section section--tight section--flush-top" aria-labelledby="h-platforms">
  <div class="wrap">
    <h2 class="sr-only" id="h-platforms"><?php echo nx_e('download.platforms_heading'); ?></h2>

    <?php if (nx_beta()): ?>
      <?php /* Before the buttons, not after: someone about to install should
               know what they are joining. */ ?>
      <div class="callout callout--info u-mb-md">
        <?php echo nx_icon('activity'); ?>
        <div>
          <p class="callout__title"><?php echo nx_e('beta.title'); ?></p>
          <p><?php echo nx_e('beta.body'); ?></p>
        </div>
      </div>
    <?php endif; ?>

    <!-- ======================= Platform tiles ======================= -->
    <div class="platforms">

      <!-- Windows -->
      <article class="platform<?php echo $nx_available ? ' platform--ready' : ''; ?>">
        <span class="platform__glyph"><?php echo nx_platform_icon('windows'); ?></span>
        <h3 class="platform__name"><?php echo nx_e('download.windows.name'); ?></h3>
        <?php if ($nx_available): ?>
          <p class="platform__meta"><?php echo nx_e('download.windows.requirements'); ?></p>
          <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_windows_download_url()); ?>">
            <?php echo nx_icon('download'); ?><span><?php echo nx_e('download.windows.button'); ?></span>
          </a>
          <p class="platform__note">
            <?php echo nx_e('download.windows.always_current'); ?>
            <?php if (nx_windows_checksum_url() !== ''): ?>
              &middot; <a href="<?php echo nx_esc(nx_windows_checksum_url()); ?>" rel="noopener"><?php echo nx_e('download.windows.checksum'); ?></a>
            <?php endif; ?>
          </p>
        <?php else: ?>
          <span class="tag"><?php echo nx_e('download.unreleased.badge'); ?></span>
          <p class="platform__meta"><?php echo nx_e('download.unreleased.body'); ?></p>
          <a class="btn btn--ghost btn--block" href="<?php echo nx_esc(nx_url('contact')); ?>">
            <?php echo nx_icon('mail'); ?><span><?php echo nx_e('download.unreleased.cta'); ?></span>
          </a>
        <?php endif; ?>
      </article>

      <!-- Android -->
      <?php if ($nx_android): ?>
        <article class="platform platform--ready">
          <span class="platform__glyph"><?php echo nx_platform_icon('android'); ?></span>
          <h3 class="platform__name"><?php echo nx_e('download.android.name'); ?></h3>
          <p class="platform__meta"><?php echo nx_e('download.android.requirements'); ?></p>
          <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_android_download_url()); ?>">
            <?php echo nx_icon('download'); ?><span><?php echo nx_e('download.android.button'); ?></span>
          </a>
          <p class="platform__note"><?php echo nx_e('download.windows.always_current'); ?></p>
        </article>
      <?php endif; ?>

      <!-- Not built yet. Config-driven, so this list and the tiles above
           cannot disagree about whether something has shipped. -->
      <?php
      $nx_platform_glyphs = array('macos' => 'apple', 'ios' => 'apple', 'android' => 'android');
      foreach ($nx_planned as $nx_key):
          $nx_glyph = isset($nx_platform_glyphs[$nx_key]) ? $nx_platform_glyphs[$nx_key] : 'apple'; ?>
        <article class="platform platform--soon">
          <span class="platform__glyph"><?php echo nx_platform_icon($nx_glyph); ?></span>
          <h3 class="platform__name"><?php echo nx_e('download.other.' . $nx_key); ?></h3>
          <span class="tag"><?php echo nx_e('download.other.status'); ?></span>
          <p class="platform__meta"><?php echo nx_e('download.other.body'); ?></p>
        </article>
      <?php endforeach; ?>
    </div>

    <!-- ========================== Guidance ========================== -->
    <div class="dl-guides">
      <div>
        <div class="notice">
          <h2><?php echo nx_e('download.steps.title'); ?></h2>
          <ol class="steps">
            <?php for ($nx_i = 1; $nx_i <= 4; $nx_i++): ?>
              <li><span><?php echo nx_e('download.steps.' . $nx_i); ?></span></li>
            <?php endfor; ?>
          </ol>
        </div>

        <?php if ($nx_android): ?>
          <div class="notice">
            <h2><?php echo nx_e('download.android.steps.title'); ?></h2>
            <ol class="steps">
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
            <h2><?php echo nx_icon('refresh'); ?><?php echo nx_e('download.autoupdate.title'); ?></h2>
            <p><?php echo nx_e('download.autoupdate.body'); ?></p>
            <?php if ($nx_android): ?>
              <?php /* Android is the exception and the page says so: the
                       system will not let an app replace its own installer
                       without the customer confirming. */ ?>
              <p class="u-mt-sm"><?php echo nx_e('download.autoupdate.android'); ?></p>
            <?php endif; ?>
          </div>
        <?php endif; ?>

        <?php if ($nx_android): ?>
          <?php /* Said plainly rather than discovered at install time: an
                   unexplained "allow installs from this source" prompt reads
                   as a suspect file. */ ?>
          <div class="notice notice--warn">
            <h2><?php echo nx_e('download.android.sideload.title'); ?></h2>
            <p><?php echo nx_e('download.android.sideload.body'); ?></p>
          </div>
        <?php endif; ?>

        <?php if (nx_cfg('windows_unsigned', true)): ?>
          <div class="notice notice--warn">
            <h2><?php echo nx_e('download.unsigned.title'); ?></h2>
            <p><?php echo nx_e('download.unsigned.body'); ?></p>
          </div>
        <?php endif; ?>
      </div>
    </div>
  </div>
</section>

<?php require NX_INC . '/partials/footer.php'; ?>
