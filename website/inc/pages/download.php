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
 * android_installer_url, linux_deb_installer_url, linux_rpm_installer_url,
 * ios_app_store_url and platforms_planned), so a
 * platform shipping is a config change, not an edit in three places that
 * can disagree.
 *
 * The Windows, Android and Linux buttons point at /get/<platform> on this site
 * (get/index.php), which hands out a copy kept here, so they work where the
 * control plane's domain is blocked. The App Store and Google Play buttons
 * are plain links in the site's own style: no store badge artwork.
 *
 * The page holds no version numbers. The configured URLs always resolve to
 * the current release, and a number printed beside a rolling link can only
 * go stale -- which is exactly what happened when this page pinned a tag.
 */

defined('NX') || exit;

$nx_available = nx_windows_available();
$nx_android = nx_android_available();
$nx_play = nx_android_play_url();
$nx_ios = nx_ios_available();
$nx_linux = nx_linux_available();
$nx_linux_deb = nx_installer_button_url('linux-deb');
$nx_linux_rpm = nx_installer_button_url('linux-rpm');
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
          <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_installer_button_url('windows')); ?>">
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
          <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_installer_button_url('android')); ?>">
            <?php echo nx_icon('download'); ?><span><?php echo nx_e('download.android.button'); ?></span>
          </a>
          <?php if ($nx_play !== ''): ?>
            <a class="btn btn--ghost btn--block" href="<?php echo nx_esc($nx_play); ?>" rel="noopener">
              <span><?php echo nx_e('download.android.play'); ?></span>
            </a>
          <?php endif; ?>
          <p class="platform__note"><?php echo nx_e('download.windows.always_current'); ?></p>
        </article>
      <?php endif; ?>

      <!-- Linux. Always shown, between Android and iPhone: as a download
           once a package is configured, and until then as not available
           yet, the way a planned platform is shown, never a dead button. -->
      <?php if ($nx_linux): ?>
        <article class="platform platform--ready">
          <span class="platform__glyph"><?php echo nx_platform_icon('linux'); ?></span>
          <h3 class="platform__name"><?php echo nx_e('download.linux.name'); ?></h3>
          <?php /* Beta on this tile alone: the first Linux version is newer
                   than the rest, and someone installing it should know. */ ?>
          <span class="tag tag--hl"><?php echo nx_e('beta.badge'); ?></span>
          <p class="platform__meta"><?php echo nx_e('download.linux.requirements'); ?></p>
          <?php if ($nx_linux_deb !== ''): ?>
            <a class="btn btn--primary btn--block" href="<?php echo nx_esc($nx_linux_deb); ?>">
              <?php echo nx_icon('download'); ?><span><?php echo nx_e('download.linux.button_deb'); ?></span>
            </a>
          <?php endif; ?>
          <?php if ($nx_linux_rpm !== ''): ?>
            <a class="btn <?php echo $nx_linux_deb !== '' ? 'btn--ghost' : 'btn--primary'; ?> btn--block" href="<?php echo nx_esc($nx_linux_rpm); ?>">
              <?php echo nx_icon('download'); ?><span><?php echo nx_e('download.linux.button_rpm'); ?></span>
            </a>
          <?php endif; ?>
          <p class="platform__note"><?php echo nx_e('download.linux.beta'); ?></p>
        </article>
      <?php else: ?>
        <article class="platform platform--soon">
          <span class="platform__glyph"><?php echo nx_platform_icon('linux'); ?></span>
          <h3 class="platform__name"><?php echo nx_e('download.linux.name'); ?></h3>
          <span class="tag"><?php echo nx_e('download.other.status'); ?></span>
          <p class="platform__meta"><?php echo nx_e('download.linux.soon'); ?></p>
        </article>
      <?php endif; ?>

      <!-- iPhone and iPad -->
      <?php if ($nx_ios): ?>
        <article class="platform platform--ready">
          <span class="platform__glyph"><?php echo nx_platform_icon('apple'); ?></span>
          <h3 class="platform__name"><?php echo nx_e('download.ios.name'); ?></h3>
          <p class="platform__meta"><?php echo nx_e('download.ios.requirements'); ?></p>
          <a class="btn btn--primary btn--block" href="<?php echo nx_esc(nx_ios_store_url()); ?>" rel="noopener">
            <span><?php echo nx_e('download.ios.button'); ?></span>
          </a>
          <p class="platform__note"><?php echo nx_e('download.ios.note'); ?></p>
        </article>
      <?php endif; ?>

      <!-- Not built yet. Config-driven, so this list and the tiles above
           cannot disagree about whether something has shipped. -->
      <?php
      $nx_platform_glyphs = array('macos' => 'apple', 'ios' => 'apple', 'android' => 'android');
      foreach ($nx_planned as $nx_key):
          if ($nx_key === 'linux') {
              continue; // it has its own tile above, in either state
          }
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

        <?php if ($nx_linux): ?>
          <?php /* The one command for each format, because opening a package
                   by double-click works on some desktops and not others,
                   and the terminal way works on all of them. The file name
                   is a pattern so the page still carries no version. */ ?>
          <div class="notice">
            <h2><?php echo nx_e('download.linux.steps.title'); ?></h2>
            <p><?php echo nx_e('download.linux.steps.intro'); ?></p>
            <?php if ($nx_linux_deb !== ''): ?>
              <p class="u-mt-sm"><?php echo nx_e('download.linux.steps.deb'); ?></p>
              <code class="cmd" dir="ltr">sudo apt install ./Neoxify_*_amd64.deb</code>
            <?php endif; ?>
            <?php if ($nx_linux_rpm !== ''): ?>
              <p class="u-mt-sm"><?php echo nx_e('download.linux.steps.rpm'); ?></p>
              <code class="cmd" dir="ltr">sudo dnf install ./Neoxify-*.x86_64.rpm</code>
            <?php endif; ?>
            <p class="u-mt-sm"><?php echo nx_e('download.linux.steps.after'); ?></p>
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
              <p class="u-mt-sm"><?php echo nx_e($nx_play !== '' ? 'download.autoupdate.android_play' : 'download.autoupdate.android'); ?></p>
            <?php endif; ?>
            <?php if ($nx_linux): ?>
              <?php /* Linux has no in-app installer for updates in its first
                       version: it tells you, and you install the new package. */ ?>
              <p class="u-mt-sm"><?php echo nx_e('download.autoupdate.linux'); ?></p>
            <?php endif; ?>
            <?php if ($nx_ios): ?>
              <p class="u-mt-sm"><?php echo nx_e('download.autoupdate.ios'); ?></p>
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
            <?php if ($nx_play !== ''): ?>
              <p class="u-mt-sm"><?php echo nx_e('download.android.sideload.play'); ?></p>
            <?php endif; ?>
          </div>
        <?php endif; ?>

        <?php if ($nx_ios): ?>
          <?php /* What is different on iPhone, said where someone choosing
                   the iPhone app will read it, not discovered after paying. */ ?>
          <div class="notice">
            <h2><?php echo nx_e('download.ios.differs.title'); ?></h2>
            <?php for ($nx_i = 1; $nx_i <= 3; $nx_i++): ?>
              <p<?php echo $nx_i > 1 ? ' class="u-mt-sm"' : ''; ?>><?php echo nx_e('download.ios.differs.' . $nx_i); ?></p>
            <?php endfor; ?>
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
