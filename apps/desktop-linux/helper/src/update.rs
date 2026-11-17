//! Installing an update from inside the app.
//!
//! The one request that makes root run something a request brought, so
//! nothing about it is taken on trust (`neoxify_linux_wire::LinuxRequest::
//! InstallUpdate`). In order:
//!
//! 1. Only the app, with no tunnel up and no connect running.
//! 2. The file is opened without following a link, must be a regular file
//!    of at most [`MAX_PACKAGE_BYTES`], and is copied into a root-only
//!    directory; from then on only the copy is used, so nothing the caller
//!    can still write is read again.
//! 3. The signature is checked over the copy against the updater's public
//!    key -- the Windows updater's, compiled in from its one place in
//!    `apps/desktop-windows/src-tauri/tauri.conf.json`.
//! 4. The package must name itself `neoxify` and be strictly newer than
//!    this helper, so an old signed package cannot be replayed to bring
//!    back an old flaw.
//! 5. The package manager runs as a transient systemd unit of its own,
//!    because the package's scripts restart this helper, and a restart
//!    kills everything in the helper's control group. Its outcome goes in a
//!    state file the next helper reads (`outcome`).

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use neoxify_linux_wire::{PackageKind, UpdateOutcome};

use crate::machine;

include!(concat!(env!("OUT_DIR"), "/updater_key.rs"));

/// The largest package accepted. A Neoxify package is tens of megabytes.
pub const MAX_PACKAGE_BYTES: u64 = 200 * 1024 * 1024;

/// The name both packages carry (`productName` lowercased by the bundler).
pub const PACKAGE_NAME: &str = "neoxify";

/// Where the installed app lives; whichever package manager owns it is
/// the one an update goes through.
const APP: &str = "/usr/bin/neoxify";
/// Where the packages install the helper.
const INSTALLED_HELPER: &str = "/usr/lib/neoxify/neoxify-helper";

const STATE_FILE: &str = "state.json";
const LOG_FILE: &str = "install.log";
const EXIT_FILE: &str = "exit-code";

const QUERY_WAIT: Duration = Duration::from_secs(20);

/// Which package manager owns this install, or why none can update it.
pub fn support() -> (Option<PackageKind>, Option<String>) {
    match std::env::current_exe() {
        Ok(exe) if exe == Path::new(INSTALLED_HELPER) => {}
        _ => return (None, Some("this helper is not the installed one, so it cannot update the install".to_string())),
    }
    if let Ok(out) = machine::run("dpkg-query", &["-S", APP], QUERY_WAIT) {
        let text = String::from_utf8_lossy(&out.stdout);
        if out.status.success() && text.lines().any(|l| l.split(':').next().map(str::trim) == Some(PACKAGE_NAME)) {
            return (Some(PackageKind::Deb), None);
        }
    }
    if let Ok(out) = machine::run("rpm", &["-qf", "--queryformat", "%{NAME}\\n", APP], QUERY_WAIT) {
        if out.status.success() && String::from_utf8_lossy(&out.stdout).lines().any(|l| l.trim() == PACKAGE_NAME) {
            return (Some(PackageKind::Rpm), None);
        }
    }
    (None, Some(format!("{APP} was not installed by dpkg or rpm, so this install cannot update itself")))
}

/// A version as three numbers; anything else is not one of ours.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let mut parts = text.trim().split('.');
    let mut next = || parts.next().filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).and_then(|p| p.parse().ok());
    let v = (next()?, next()?, next()?);
    parts.next().is_none().then_some(v)
}

/// Opens the downloaded package: no link followed for its last part, no
/// blocking on a FIFO, a regular file, not empty and not too large.
pub fn open_package(path: &str) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    if !path.starts_with('/') || path.contains('\0') || path.len() > 4096 {
        return Err("the update's file is not an absolute path".to_string());
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOCTTY)
        .open(path)
        // The two a customer can meet named in words, not in the system's
        // ("entity not found").
        .map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) => "the update's file is a link, which is not accepted".to_string(),
            Some(libc::ENOENT) => "the downloaded update is no longer there; download it again".to_string(),
            Some(libc::EACCES | libc::EPERM) => "the helper is not allowed to read the downloaded update".to_string(),
            _ => format!("the update's file could not be opened: {}", e.kind()),
        })?;
    let meta = file.metadata().map_err(|e| format!("the update's file could not be read: {}", e.kind()))?;
    if !meta.file_type().is_file() {
        return Err("the update's file is not a regular file".to_string());
    }
    if meta.len() == 0 {
        return Err("the update's file is empty".to_string());
    }
    if meta.len() > MAX_PACKAGE_BYTES {
        return Err(format!("the update's file is larger than {} MB", MAX_PACKAGE_BYTES / (1024 * 1024)));
    }
    Ok(file)
}

/// Refuses a package that is not the asking user's own file.
pub fn owned_by(file: &File, owner: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    // Root may read every file anyway, so a root caller learns nothing new.
    let Some(uid) = owner.filter(|uid| *uid != 0) else { return Ok(()) };
    let meta = file.metadata().map_err(|e| format!("the update's file could not be read: {}", e.kind()))?;
    if meta.uid() != uid {
        return Err("the update's file is not one you downloaded".to_string());
    }
    Ok(())
}

/// The root-only directory updates are copied into, made if missing,
/// refused if it is not a real directory, and emptied of an earlier try.
pub fn prepare_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_dir() => {}
        Ok(_) => return Err("the update directory is not a directory".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(dir).map_err(|e| format!("the update directory could not be made: {e}"))?
        }
        Err(e) => return Err(format!("the update directory could not be read: {e}")),
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("the update directory could not be made private: {e}"))?;
    for name in [copy_name(PackageKind::Deb), copy_name(PackageKind::Rpm), STATE_FILE, LOG_FILE, EXIT_FILE] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    let _ = std::fs::remove_file(dir.join(format!("{EXIT_FILE}.tmp")));
    Ok(())
}

pub fn copy_name(kind: PackageKind) -> &'static str {
    match kind {
        PackageKind::Deb => "neoxify-update.deb",
        PackageKind::Rpm => "neoxify-update.rpm",
    }
}

/// Copies at most [`MAX_PACKAGE_BYTES`] into a new file only root can
/// read. A file that grows past the limit while it is copied is refused.
pub fn copy_into(mut from: File, to: &Path) -> Result<u64, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(to)
        .map_err(|e| format!("the update could not be copied: {e}"))?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut total: u64 = 0;
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                return Err("the update's file could not be read to the end".to_string())
            }
            Err(e) => return Err(format!("the update's file could not be read: {}", e.kind())),
        };
        total += n as u64;
        if total > MAX_PACKAGE_BYTES {
            return Err(format!("the update's file is larger than {} MB", MAX_PACKAGE_BYTES / (1024 * 1024)));
        }
        out.write_all(&buf[..n]).map_err(|e| format!("the update could not be copied: {e}"))?;
    }
    out.sync_all().map_err(|e| format!("the update could not be copied: {e}"))?;
    Ok(total)
}

fn decode_text(b64: &str, what: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| format!("the {what} is not in the form the updater publishes"))?;
    String::from_utf8(bytes).map_err(|_| format!("the {what} is not in the form the updater publishes"))
}

/// Checks `signature` -- base64 of a minisign signature file, as `tauri
/// signer sign` writes it -- over the file at `path`, against `pubkey`,
/// base64 of a minisign public-key file. Only prehashed signatures, the
/// kind the signer makes.
pub fn verify(path: &Path, signature: &str, pubkey: &str) -> Result<(), String> {
    if signature.trim().is_empty() {
        return Err("the update came without its signature, so it was not installed".to_string());
    }
    let key = minisign_verify::PublicKey::decode(&decode_text(pubkey, "updater key")?)
        .map_err(|_| "the updater key compiled into the helper is unreadable".to_string())?;
    let sig = minisign_verify::Signature::decode(&decode_text(signature, "signature")?)
        .map_err(|_| "the signature is not in the form the updater publishes".to_string())?;
    let mut check = key.verify_stream(&sig).map_err(|_| "the update is not signed with Neoxify's updater key".to_string())?;
    let mut file = File::open(path).map_err(|e| format!("the copied update could not be read: {e}"))?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("the copied update could not be read: {e}"))?;
        if n == 0 {
            break;
        }
        check.update(&buf[..n]);
    }
    check.finalize().map_err(|_| "the update's signature does not match the file; it was not installed".to_string())
}

/// The package's own name and version, read by the system's tools from
/// the (already verified) copy.
pub fn identity(kind: PackageKind, copy: &Path) -> Result<(String, String), String> {
    let copy = copy.to_str().ok_or("the copied update has an unreadable name")?;
    let out = match kind {
        PackageKind::Deb => machine::run("dpkg-deb", &["--field", copy, "Package", "Version"], QUERY_WAIT)?,
        PackageKind::Rpm => machine::run("rpm", &["-qp", "--queryformat", "Package: %{NAME}\\nVersion: %{VERSION}\\n", copy], QUERY_WAIT)?,
    };
    if !out.status.success() {
        return Err("the package's name and version could not be read".to_string());
    }
    parse_fields(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| "the package's name and version could not be read".to_string())
}

/// `Package:` and `Version:` from dpkg-deb's (and our rpm query's) output.
pub fn parse_fields(text: &str) -> Option<(String, String)> {
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)).map(|v| v.trim().to_string());
    Some((field("Package:")?, field("Version:")?))
}

/// Whether `candidate` (name, version) may replace a helper of `running`.
pub fn acceptable(name: &str, version: &str, running: &str) -> Result<(), String> {
    if name != PACKAGE_NAME {
        return Err(format!("the package is not Neoxify's own (it calls itself {name:?})"));
    }
    let Some(new) = parse_version(version) else {
        return Err("the package's version is not one Neoxify publishes".to_string());
    };
    let Some(now) = parse_version(running) else { return Err("this helper's own version is unreadable".to_string()) };
    if new <= now {
        return Err(format!("the package is version {version}, which is not newer than the installed {running}"));
    }
    Ok(())
}

/// The shell line the transient unit runs. Every path in it is ours, and
/// checked to be plain, so nothing from a request is ever in it.
pub fn script(kind: PackageKind, dir: &Path, manager: &Path) -> Result<String, String> {
    let plain = |p: &Path| {
        p.to_str()
            .filter(|s| s.starts_with('/') && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b)))
            .map(str::to_string)
            .ok_or_else(|| "an update path is not plain".to_string())
    };
    let copy = plain(&dir.join(copy_name(kind)))?;
    let log = plain(&dir.join(LOG_FILE))?;
    let code = plain(&dir.join(EXIT_FILE))?;
    let manager = plain(manager)?;
    let name = Path::new(&manager).file_name().and_then(|n| n.to_str()).unwrap_or("");
    let install = match name {
        "apt-get" => format!("{manager} install -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold {copy}"),
        "dnf" => format!("{manager} install -y {copy}"),
        "zypper" => format!("{manager} --non-interactive install --allow-unsigned-rpm {copy}"),
        "rpm" => format!("{manager} -U {copy}"),
        _ => return Err("no package manager this knows".to_string()),
    };
    Ok(format!("{install} >{log} 2>&1; echo $? >{code}.tmp; mv {code}.tmp {code}"))
}

/// The package manager for a format: apt-get for a .deb; dnf, then
/// zypper, then plain rpm for an .rpm.
pub fn manager(kind: PackageKind) -> Option<PathBuf> {
    let names: &[&str] = match kind {
        PackageKind::Deb => &["apt-get"],
        PackageKind::Rpm => &["dnf", "zypper", "rpm"],
    };
    names.iter().find_map(|n| machine::program(n))
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
struct Record {
    version: String,
    unit: String,
}

/// Everything after the caller and the tunnel were checked.
///
///  is the asking user: the package must be their own file. Root
/// opens it, and without this a caller could name any file on the machine
/// and have root copy it. Whether a named file exists still shows in the
/// answer (and whether it is empty or over the size limit); its contents
/// and exact size do not.
pub fn install(dir: &Path, kind: PackageKind, package: &str, signature: &str, owner: Option<u32>) -> Result<(), String> {
    let shown = Path::new(package).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let file = open_package(package)?;
    owned_by(&file, owner)?;
    prepare_dir(dir)?;
    let copy = dir.join(copy_name(kind));
    copy_into(file, &copy)?;
    let checked = verify(&copy, signature, UPDATER_PUBKEY)
        .and_then(|()| identity(kind, &copy))
        .and_then(|(name, version)| acceptable(&name, &version, crate::VERSION).map(|()| version));
    let version = match checked {
        Ok(version) => version,
        Err(why) => {
            let _ = std::fs::remove_file(&copy);
            crate::say!("neoxify-helper: an update ({shown}) was refused: {why}");
            return Err(why);
        }
    };
    let manager = manager(kind).ok_or("no package manager was found to install the update")?;
    let script = script(kind, dir, &manager)?;
    let unit = format!(
        "neoxify-update-{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    );
    let record = Record { version: version.clone(), unit: unit.clone() };
    std::fs::write(dir.join(STATE_FILE), serde_json::to_vec(&record).unwrap_or_default())
        .map_err(|e| format!("the update's state could not be written: {e}"))?;
    let unit_arg = format!("--unit={unit}");
    let out = machine::run(
        "systemd-run",
        &[
            &unit_arg,
            "--collect",
            "--quiet",
            "--description=Neoxify update",
            "--setenv=DEBIAN_FRONTEND=noninteractive",
            "/bin/sh",
            "-c",
            &script,
        ],
        QUERY_WAIT,
    )?;
    if !out.status.success() {
        let _ = std::fs::remove_file(dir.join(STATE_FILE));
        return Err(format!(
            "the package manager could not be started: {}",
            String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("")
        ));
    }
    crate::say!("neoxify-helper: installing the update to {version} ({shown}) in {unit}");
    Ok(())
}

/// How the last install went, from the state file. `unit_active` asks
/// systemd whether the unit is still running (`None` when it cannot say).
pub fn outcome(dir: &Path, running: &str, unit_active: impl Fn(&str) -> Option<bool>) -> UpdateOutcome {
    let Ok(raw) = std::fs::read(dir.join(STATE_FILE)) else { return UpdateOutcome::None };
    let Ok(record) = serde_json::from_slice::<Record>(&raw) else { return UpdateOutcome::None };
    let version = record.version;
    match std::fs::read_to_string(dir.join(EXIT_FILE)).ok().and_then(|t| t.trim().parse::<i32>().ok()) {
        Some(0) if version == running => UpdateOutcome::Installed { version },
        Some(0) => match unit_active(&record.unit) {
            Some(false) => UpdateOutcome::Failed {
                version,
                detail: format!("the package manager finished, but the helper running is still {running}"),
            },
            _ => UpdateOutcome::Running { version },
        },
        Some(code) => UpdateOutcome::Failed { version, detail: last_words(&dir.join(LOG_FILE), code) },
        None => match unit_active(&record.unit) {
            Some(false) if version == running => UpdateOutcome::Installed { version },
            Some(false) => UpdateOutcome::Failed { version, detail: "the install stopped without saying how it went".to_string() },
            _ => UpdateOutcome::Running { version },
        },
    }
}

/// The package manager's last lines, bounded.
fn last_words(log: &Path, code: i32) -> String {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail: Vec<String> = lines[lines.len().saturating_sub(6)..].iter().map(|l| l.chars().take(300).collect()).collect();
    if tail.is_empty() {
        format!("the package manager stopped with code {code}")
    } else {
        format!("the package manager stopped with code {code}: {}", tail.join(" / "))
    }
}

/// Whether systemd still runs the unit.
pub fn unit_active(unit: &str) -> Option<bool> {
    let out = machine::run("systemctl", &["is-active", "--quiet", unit], Duration::from_secs(5)).ok()?;
    Some(out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    /// A throwaway minisign key pair, made here, never the real one: the
    /// public key and a signer, both as the updater publishes them.
    struct Throwaway {
        key: SigningKey,
        id: [u8; 8],
    }

    impl Throwaway {
        fn new(seed: u8) -> Self {
            Self { key: SigningKey::from_bytes(&[seed; 32]), id: [seed, 1, 2, 3, 4, 5, 6, 7] }
        }

        fn public(&self) -> String {
            let mut raw = b"Ed".to_vec();
            raw.extend(self.id);
            raw.extend(self.key.verifying_key().to_bytes());
            b64(format!("untrusted comment: minisign public key: test\n{}\n", b64(&raw)).as_bytes())
        }

        /// What `tauri signer sign` writes for `data`: a prehashed minisign
        /// signature file, base64 as a whole.
        fn sign(&self, data: &[u8]) -> String {
            use blake2::Digest;
            let hash = blake2::Blake2b512::digest(data);
            let sig = self.key.sign(&hash).to_bytes();
            let mut line = b"ED".to_vec();
            line.extend(self.id);
            line.extend(sig);
            let trusted = "timestamp:1\tfile:neoxify.deb\thashed";
            let mut global = sig.to_vec();
            global.extend(trusted.as_bytes());
            let global = self.key.sign(&global).to_bytes();
            b64(format!(
                "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {trusted}\n{}\n",
                b64(&line),
                b64(&global)
            )
            .as_bytes())
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nxh-update-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_compiled_in_key_is_the_windows_updaters_and_reads_as_a_minisign_key() {
        let conf = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../desktop-windows/src-tauri/tauri.conf.json"),
        )
        .expect("the Windows updater's config");
        let conf: serde_json::Value = serde_json::from_str(&conf).unwrap();
        assert_eq!(conf["plugins"]["updater"]["pubkey"].as_str(), Some(UPDATER_PUBKEY), "the two keys differ");
        assert!(minisign_verify::PublicKey::decode(&decode_text(UPDATER_PUBKEY, "key").unwrap()).is_ok());
    }

    #[test]
    fn a_signed_file_verifies_and_anything_else_does_not() {
        let dir = scratch("verify");
        let file = dir.join("p.deb");
        std::fs::write(&file, b"a package's bytes").unwrap();
        let ours = Throwaway::new(7);
        let sig = ours.sign(b"a package's bytes");
        assert_eq!(verify(&file, &sig, &ours.public()), Ok(()));

        // Another key, another file, a mangled signature, the real key.
        assert!(verify(&file, &sig, &Throwaway::new(9).public()).is_err());
        assert!(verify(&file, &ours.sign(b"other bytes"), &ours.public()).is_err());
        assert!(verify(&file, "not base64 at all!", &ours.public()).is_err());
        assert!(verify(&file, &sig, UPDATER_PUBKEY).is_err(), "a throwaway key's signature passed the real key");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_package_must_be_neoxify_and_newer() {
        assert_eq!(acceptable("neoxify", "0.2.1", "0.2.0"), Ok(()));
        assert_eq!(acceptable("neoxify", "1.0.0", "0.9.9"), Ok(()));
        assert!(acceptable("neoxify", "0.2.0", "0.2.0").is_err(), "the same version");
        assert!(acceptable("neoxify", "0.1.9", "0.2.0").is_err(), "an older version replayed");
        assert!(acceptable("neoxify", "0.10.0", "0.9.0").is_ok(), "compared as numbers, not text");
        assert!(acceptable("neoxify-evil", "9.0.0", "0.2.0").is_err());
        assert!(acceptable("neoxify", "0.2.1-1", "0.2.0").is_err());
        assert_eq!(parse_fields("Package: neoxify\nVersion: 0.2.1\n"), Some(("neoxify".into(), "0.2.1".into())));
    }

    #[test]
    fn only_a_plain_regular_file_of_bounded_size_is_opened() {
        let dir = scratch("open");
        let real = dir.join("real.deb");
        std::fs::write(&real, b"x").unwrap();
        assert!(open_package(real.to_str().unwrap()).is_ok());
        let link = dir.join("link.deb");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(open_package(link.to_str().unwrap()).unwrap_err().contains("link"));
        assert!(open_package(dir.to_str().unwrap()).unwrap_err().contains("regular"));
        let empty = dir.join("empty.deb");
        std::fs::write(&empty, b"").unwrap();
        assert!(open_package(empty.to_str().unwrap()).unwrap_err().contains("empty"));
        let big = dir.join("big.deb");
        std::fs::File::create(&big).unwrap().set_len(MAX_PACKAGE_BYTES + 1).unwrap();
        assert!(open_package(big.to_str().unwrap()).unwrap_err().contains("larger"));
        assert!(open_package("relative.deb").is_err());
        // Only the asking user's own file is taken.
        // SAFETY: a plain system call with no arguments.
        let me = unsafe { libc::getuid() };
        assert!(owned_by(&open_package(real.to_str().unwrap()).unwrap(), Some(me)).is_ok());
        if me != 0 {
            assert!(owned_by(&open_package(real.to_str().unwrap()).unwrap(), Some(me + 1)).unwrap_err().contains("not one you"));
        }
        assert!(owned_by(&open_package(real.to_str().unwrap()).unwrap(), Some(0)).is_ok(), "root's own tools");
        assert!(owned_by(&open_package(real.to_str().unwrap()).unwrap(), None).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_copy_is_private_and_new() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("copy");
        let from = dir.join("from.deb");
        std::fs::write(&from, b"payload").unwrap();
        let update = dir.join("update");
        prepare_dir(&update).unwrap();
        assert_eq!(std::fs::metadata(&update).unwrap().permissions().mode() & 0o777, 0o700);
        let to = update.join(copy_name(PackageKind::Deb));
        assert_eq!(copy_into(open_package(from.to_str().unwrap()).unwrap(), &to), Ok(7));
        assert_eq!(std::fs::metadata(&to).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(copy_into(open_package(from.to_str().unwrap()).unwrap(), &to).is_err(), "an existing copy was overwritten");
        prepare_dir(&update).unwrap();
        assert!(!to.exists(), "an earlier try was left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_script_names_only_our_paths() {
        let s = script(PackageKind::Deb, Path::new("/var/lib/neoxify/update"), Path::new("/usr/bin/apt-get")).unwrap();
        assert!(s.starts_with("/usr/bin/apt-get install -y"), "{s}");
        assert!(s.contains("/var/lib/neoxify/update/neoxify-update.deb"));
        let s = script(PackageKind::Rpm, Path::new("/var/lib/neoxify/update"), Path::new("/usr/bin/dnf")).unwrap();
        assert!(s.contains("dnf install -y /var/lib/neoxify/update/neoxify-update.rpm"), "{s}");
        assert!(script(PackageKind::Deb, Path::new("/var/lib/x y;rm"), Path::new("/usr/bin/apt-get")).is_err());
    }

    #[test]
    fn the_outcome_is_read_from_what_the_last_helper_left() {
        let dir = scratch("outcome");
        assert_eq!(outcome(&dir, "0.2.0", |_| None), UpdateOutcome::None);
        std::fs::write(dir.join(STATE_FILE), br#"{"version":"0.2.1","unit":"neoxify-update-1"}"#).unwrap();
        assert_eq!(outcome(&dir, "0.2.0", |_| Some(true)), UpdateOutcome::Running { version: "0.2.1".into() });
        assert!(matches!(outcome(&dir, "0.2.0", |_| Some(false)), UpdateOutcome::Failed { .. }));
        std::fs::write(dir.join(EXIT_FILE), "0\n").unwrap();
        assert_eq!(outcome(&dir, "0.2.1", |_| Some(false)), UpdateOutcome::Installed { version: "0.2.1".into() });
        std::fs::write(dir.join(EXIT_FILE), "100\n").unwrap();
        std::fs::write(dir.join(LOG_FILE), "Reading package lists...\nE: Could not get lock /var/lib/dpkg/lock-frontend\n").unwrap();
        let UpdateOutcome::Failed { detail, .. } = outcome(&dir, "0.2.0", |_| Some(false)) else { panic!("not failed") };
        assert!(detail.contains("code 100") && detail.contains("Could not get lock"), "{detail}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
