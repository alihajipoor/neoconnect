//! Updates installed from inside the app: the download half, and the
//! relaunch afterwards.
//!
//! The app only fetches the package, as the user, into the user's cache.
//! Everything that decides whether it may be installed (its signature, that
//! it is Neoxify's, that it is newer) is checked by the helper, which is
//! root and trusts nothing this side says (`linux_requests.rs`). The checks
//! here are about not being made to fetch something silly: https only, to
//! the end of every redirect, and nothing larger than a package could be.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tauri::Emitter;

/// Far above any package we publish (tens of megabytes) and far below
/// what would fill a disk.
const MAX_BYTES: u64 = 200 * 1024 * 1024;

/// A stalled transfer is given up rather than left spinning. Per read,
/// not for the whole file: on a slow line a whole package takes minutes.
const STALL_LIMIT: Duration = Duration::from_secs(60);

/// How often progress is reported, in bytes.
const PROGRESS_STEP: u64 = 256 * 1024;

#[derive(Debug, Clone)]
pub struct Download {
    pub path: PathBuf,
    pub signature: String,
    #[allow(dead_code)]
    pub version: String,
}

/// The last finished download, for `linux_update_install`, and whether one
/// is under way.
#[derive(Default)]
pub struct Downloaded {
    last: Mutex<Option<Download>>,
    busy: Mutex<bool>,
}

impl Downloaded {
    pub fn current(&self) -> Option<Download> {
        self.last.lock().ok().and_then(|g| g.clone())
    }
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// What the request names, once it has passed the checks: the URL, and
/// the file name it will be saved under.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Checked {
    pub url: reqwest::Url,
    pub file_name: String,
}

/// Refuses anything that is not an https URL to a .deb or .rpm, or a
/// version that is not a plain version string. The file is named from the
/// version, never from the URL, so nothing the server says decides a path.
pub(crate) fn check_request(url: &str, signature: &str, version: &str) -> Result<Checked, String> {
    let url = reqwest::Url::parse(url).map_err(|_| "The update's address is not a valid URL.".to_string())?;
    if url.scheme() != "https" {
        return Err("The update's address is not https.".to_string());
    }
    if url.host_str().is_none_or(str::is_empty) || !url.username().is_empty() || url.password().is_some() {
        return Err("The update's address is not a plain web address.".to_string());
    }
    let last = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or("").to_ascii_lowercase();
    let ext = if last.ends_with(".deb") {
        "deb"
    } else if last.ends_with(".rpm") {
        "rpm"
    } else {
        return Err("The update is not a .deb or .rpm package.".to_string());
    };
    let plain = !version.is_empty()
        && version.len() <= 64
        && version.chars().next().is_some_and(|c| c.is_ascii_digit())
        && version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+' | '~'));
    if !plain {
        return Err("The update's version is not a plain version number.".to_string());
    }
    if signature.trim().is_empty() || signature.len() > 16 * 1024 {
        return Err("The update has no usable signature.".to_string());
    }
    Ok(Checked { url, file_name: format!("neoxify-{version}.{ext}") })
}

/// Follows redirects only to https, and not forever: the published URL
/// goes through the API's own redirect to the release host.
fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.url().scheme() != "https" {
            attempt.error("the update's address redirected away from https")
        } else if attempt.previous().len() >= 10 {
            attempt.error("the update's address redirected too many times")
        } else {
            attempt.follow()
        }
    })
}

/// `$XDG_CACHE_HOME/neoxify/updates`, or `~/.cache/neoxify/updates`.
pub(crate) fn updates_dir(cache_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match cache_home.filter(|c| c.starts_with('/')) {
        Some(c) => PathBuf::from(c),
        None => PathBuf::from(home.filter(|h| h.starts_with('/'))?).join(".cache"),
    };
    Some(base.join("neoxify").join("updates"))
}

/// Downloads the package, reporting "linux-update-progress" as it goes,
/// and remembers it for `linux_update_install`. Earlier downloads are
/// removed first: only the newest package is ever worth keeping.
#[tauri::command]
pub async fn linux_update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, Downloaded>,
    url: String,
    signature: String,
    version: String,
) -> Result<(), String> {
    let checked = check_request(&url, &signature, &version)?;
    {
        let mut busy = state.busy.lock().map_err(|_| "The download could not start.".to_string())?;
        if *busy {
            return Err("The update is already downloading.".to_string());
        }
        *busy = true;
    }
    let result = fetch(&app, &checked).await;
    if let Ok(mut busy) = state.busy.lock() {
        *busy = false;
    }
    let path = result?;
    if let Ok(mut last) = state.last.lock() {
        *last = Some(Download { path, signature, version });
    }
    Ok(())
}

async fn fetch(app: &tauri::AppHandle, checked: &Checked) -> Result<PathBuf, String> {
    let dir = updates_dir(std::env::var("XDG_CACHE_HOME").ok().as_deref(), std::env::var("HOME").ok().as_deref())
        .ok_or_else(|| "There is no cache directory to download the update into.".to_string())?;
    clear_dir(&dir);
    create_private_dir(&dir).map_err(|e| format!("Could not make a place for the update: {e}"))?;
    let target = dir.join(&checked.file_name);
    let partial = dir.join(format!("{}.part", checked.file_name));

    let outcome = download_to(app, &checked.url, &partial).await;
    match outcome {
        Ok(()) => {
            std::fs::rename(&partial, &target).map_err(|e| format!("Could not keep the downloaded update: {e}"))?;
            Ok(target)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&partial);
            Err(e)
        }
    }
}

async fn download_to(app: &tauri::AppHandle, url: &reqwest::Url, partial: &Path) -> Result<(), String> {
    use std::io::Write;

    let client = reqwest::Client::builder()
        .redirect(redirect_policy())
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        // The package's own bytes, as published: the HTTP plugin's `gzip`
        // feature turns reqwest's decompression on for every client in the
        // build, and this one is not meant to have it.
        .no_gzip()
        .build()
        .map_err(|e| format!("Could not start the download: {e}"))?;
    let mut response = tokio::time::timeout(STALL_LIMIT, client.get(url.clone()).send())
        .await
        .map_err(|_| "The update server did not answer.".to_string())?
        .map_err(|e| format!("Could not download the update: {}", without_url(&e)))?;
    if !response.status().is_success() {
        return Err(format!("The update server answered {}.", response.status().as_u16()));
    }
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_BYTES) {
        return Err("The update is larger than any Neoxify package; it was not downloaded.".to_string());
    }
    let mut file = std::fs::File::create(partial).map_err(|e| format!("Could not save the update: {e}"))?;
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    let _ = app.emit("linux-update-progress", Progress { downloaded, total });
    loop {
        let chunk = tokio::time::timeout(STALL_LIMIT, response.chunk())
            .await
            .map_err(|_| "The download stalled. Try again.".to_string())?
            .map_err(|e| format!("The download was cut off: {}", without_url(&e)))?;
        let Some(chunk) = chunk else { break };
        downloaded += chunk.len() as u64;
        if downloaded > MAX_BYTES || total.is_some_and(|t| downloaded > t) {
            return Err("The update is larger than it said it was; it was not kept.".to_string());
        }
        file.write_all(&chunk).map_err(|e| format!("Could not save the update: {e}"))?;
        if downloaded - reported >= PROGRESS_STEP {
            reported = downloaded;
            let _ = app.emit("linux-update-progress", Progress { downloaded, total });
        }
    }
    if total.is_some_and(|t| downloaded != t) {
        return Err("The download ended early. Try again.".to_string());
    }
    file.sync_all().map_err(|e| format!("Could not save the update: {e}"))?;
    let _ = app.emit("linux-update-progress", Progress { downloaded, total });
    Ok(())
}

/// reqwest's error text carries the URL, which may hold a signed query;
/// it is not repeated into a message a customer may paste into support.
fn without_url(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "it timed out"
    } else if e.is_connect() {
        "no connection to the update server"
    } else if e.is_redirect() {
        "the address redirected somewhere it may not"
    } else if e.is_body() || e.is_decode() {
        "the transfer broke off"
    } else {
        "the request failed"
    }
}

fn clear_dir(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for item in read.flatten() {
        if item.file_type().is_ok_and(|t| t.is_file() || t.is_symlink()) {
            let _ = std::fs::remove_file(item.path());
        }
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Where the installed program is after its package has been replaced.
/// The running process's own path then reads "... (deleted)", because the
/// file it was started from is gone; the new one is at the same place.
pub(crate) fn binary_after_replace(raw: &Path) -> PathBuf {
    let text = raw.to_string_lossy();
    PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(&text).to_string())
}

/// Starts the app again once this one has gone, then quits. In that
/// order, because a second instance started while this one is alive is
/// turned away by single-instance and only brings this window forward.
#[tauri::command]
pub fn linux_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe()
        .map(|p| binary_after_replace(&p))
        .ok()
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("/usr/bin/neoxify"));
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg("while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec \"$2\"")
        .arg("neoxify-relaunch")
        .arg(std::process::id().to_string())
        .arg(&exe)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Could not start Neoxify again: {e}"))?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==";

    #[test]
    fn a_package_url_over_https_is_accepted_and_named_from_the_version() {
        let c = check_request("https://api.example.com/updates/download/linux-v0.2.1/neoxify_0.2.1_amd64.deb", SIG, "0.2.1")
            .unwrap();
        assert_eq!(c.file_name, "neoxify-0.2.1.deb");
        let c = check_request("https://example.com/a/neoxify-0.2.1-1.x86_64.rpm", SIG, "0.2.1").unwrap();
        assert_eq!(c.file_name, "neoxify-0.2.1.rpm");
    }

    #[test]
    fn what_the_download_refuses() {
        let deb = "https://example.com/neoxify.deb";
        assert!(check_request("http://example.com/neoxify.deb", SIG, "0.2.1").is_err());
        assert!(check_request("file:///tmp/neoxify.deb", SIG, "0.2.1").is_err());
        assert!(check_request("https://user:pw@example.com/neoxify.deb", SIG, "0.2.1").is_err());
        assert!(check_request("https://example.com/neoxify.sh", SIG, "0.2.1").is_err());
        assert!(check_request("not a url", SIG, "0.2.1").is_err());
        assert!(check_request(deb, SIG, "../../etc/x").is_err());
        assert!(check_request(deb, SIG, "0.2.1/x").is_err());
        assert!(check_request(deb, SIG, "").is_err());
        assert!(check_request(deb, SIG, "v0.2.1").is_err());
        assert!(check_request(deb, "  ", "0.2.1").is_err());
        assert!(check_request(deb, SIG, "0.2.1").is_ok());
    }

    #[test]
    fn the_cache_directory_follows_xdg() {
        assert_eq!(updates_dir(Some("/c"), Some("/home/u")), Some(PathBuf::from("/c/neoxify/updates")));
        assert_eq!(updates_dir(Some("relative"), Some("/home/u")), Some(PathBuf::from("/home/u/.cache/neoxify/updates")));
        assert_eq!(updates_dir(None, None), None);
    }

    #[test]
    fn a_replaced_binary_is_found_at_its_old_path() {
        assert_eq!(binary_after_replace(Path::new("/usr/bin/neoxify (deleted)")), PathBuf::from("/usr/bin/neoxify"));
        assert_eq!(binary_after_replace(Path::new("/usr/bin/neoxify")), PathBuf::from("/usr/bin/neoxify"));
    }

    #[test]
    fn old_downloads_are_cleared() {
        let dir = std::env::temp_dir().join(format!("nx-upd-test-{}", std::process::id()));
        create_private_dir(&dir).unwrap();
        std::fs::write(dir.join("neoxify-0.1.0.deb"), b"x").unwrap();
        std::fs::write(dir.join("neoxify-0.2.0.deb.part"), b"x").unwrap();
        clear_dir(&dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
