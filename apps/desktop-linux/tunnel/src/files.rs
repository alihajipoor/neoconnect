//! Files that hold credentials or the ledger.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Writes `bytes` to a file only root can read (0600).
///
/// Any earlier file is removed first: the mode given at open applies only
/// to a file being created, so truncating one that was left world-readable
/// would keep it readable with credentials in it.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_private_file_is_owner_only_even_over_a_readable_one() {
        let dir = std::env::temp_dir().join(format!("neoxify-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&path, b"secret").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read(&path).unwrap(), b"secret");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
