//! The settings screen's list of running applications.
//!
//! Moved out of `owner.rs`, which answers which process owns a packet's
//! port -- a question asked on every packet. Nothing here is on that
//! path. It groups the machine's processes into products, names them,
//! picks the binary to show and fetches its icon, for a picker that
//! re-lists every few seconds while it is open.
//!
//! What it shares with the packet path is `image_path`, borrowed from
//! `owner.rs`, so both identify a process by exactly the same string.

use std::collections::HashMap;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

use super::owner::image_path;

/// The applications a customer would recognise, grouped one entry per
/// product, for the picker to offer.
///
/// Every running executable outside the Windows system directories is a
/// candidate (see [`is_user_application`]). Which of them have a window
/// the customer can see is decided by the Tauri client, not here: this
/// is a LocalSystem service in session 0, where a window enumeration
/// sees none of the customer's.
///
/// Grouping is by the product name recorded in the executable itself,
/// falling back to the install directory when there is none. That is
/// what puts `Discord.exe` and `Update.exe` under a single "Discord".
/// Sorted by name so the order does not shuffle between refreshes.
pub fn running_apps() -> Vec<neoconnect_ipc::RunningApp> {
    let mut by_product: HashMap<String, (String, Vec<String>, Vec<u32>)> = HashMap::new();

    // SAFETY: a plain call; an invalid handle is checked below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() {
        return Vec::new();
    }
    // SAFETY: zeroed is a valid PROCESSENTRY32W once dwSize is set, and
    // setting it is what the API uses to version the struct.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    // SAFETY: the handle is valid until CloseHandle below.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        let pid = entry.th32ProcessID;
        if let Some(path) = image_path(pid) {
            if is_user_application(&path) {
                let (key, label) = product_of(&path);
                let slot = by_product
                    .entry(key)
                    .or_insert_with(|| (label, Vec::new(), Vec::new()));
                let lowered = path.to_lowercase();
                if !slot.1.iter().any(|p| p.to_lowercase() == lowered) {
                    slot.1.push(path);
                }
                slot.2.push(pid);
            }
        }
        // SAFETY: same handle and entry as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: the snapshot handle is valid and not used again.
    unsafe { CloseHandle(snapshot) };

    // Every sibling goes with the group, so choosing one product routes
    // all of it -- but siblings that are not running are unknown here,
    // which is why the group is built from what the product is rather
    // than from what happens to be on screen.
    let mut apps: Vec<neoconnect_ipc::RunningApp> = by_product
        .into_values()
        .filter_map(|(name, mut paths, pids)| {
            paths.sort();
            // The executable a person associates with the product, not
            // whichever sorts first. Microsoft Edge ships an
            // `elevation_service.exe` that sorts before `msedge.exe`,
            // and taking the first put a service's icon and path under
            // the name "Microsoft Edge".
            //
            // The closest match to the product's own name wins: it is
            // what publishers name their main binary after, and the one
            // whose icon is the product's.
            let path = pick_primary(&name, &paths)?;
            // Taken from the executable shown, which is the one whose
            // icon a person associates with the product.
            let icon = super::icon::icon_png_base64(&path);
            Some(neoconnect_ipc::RunningApp { path, name, paths, icon, pids })
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

/// The executable that best represents a product.
///
/// Scored rather than guessed: an exact stem match first, then one that
/// contains the product's letters, then the shortest name -- helpers are
/// almost always the longer, more qualified ones
/// (`elevation_service`, `crashpad_handler`, `Update`).
fn pick_primary(product: &str, paths: &[String]) -> Option<String> {
    let wanted: String = product
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();

    paths
        .iter()
        .min_by_key(|path| {
            let stem: String = std::path::Path::new(path.as_str())
                .file_stem()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .collect();
            let rank = if stem == wanted {
                0
            } else if !wanted.is_empty() && (wanted.contains(&stem) || stem.contains(&wanted)) {
                1
            } else {
                2
            };
            (rank, stem.len())
        })
        .cloned()
}

/// A grouping key and a display name for whatever product owns this
/// executable.
///
/// The product name inside the binary is the only thing that reliably
/// ties several executables together -- file names do not (`Update.exe`
/// is a dozen different products) and neither do directories, since a
/// launcher and the program it launches often sit in different folders
/// under one install root.
fn product_of(path: &str) -> (String, String) {
    // The friendly name first: "Notepad" rather than "Microsoft(R)
    // Windows(R) Operating System", which is what ProductName says for
    // every accessory Windows ships.
    let description = version_string(path, "FileDescription");

    if let Some(product) = product_name(path) {
        let trimmed = product.trim();
        // Some publishers put the platform in ProductName rather than
        // the program, and Microsoft puts it on everything from Notepad
        // to Explorer. Grouping on that collapses a dozen unrelated
        // accessories into one entry -- measured here as a single
        // "Windows Operating System" holding nine executables, which a
        // customer selecting it would have tunnelled all of.
        //
        // Those are not one product to anybody using them, so they are
        // kept apart and named individually.
        if !trimmed.is_empty() && !is_platform_product(trimmed) {
            let label = description.unwrap_or_else(|| trimmed.to_string());
            return (trimmed.to_lowercase(), label);
        }
        if !trimmed.is_empty() {
            let label = description.unwrap_or_else(|| file_label(path));
            // Keyed by the executable, so each accessory stands alone.
            return (path.to_lowercase(), label);
        }
    }
    if let Some(label) = description {
        return (path.to_lowercase(), label);
    }
    // No version block: fall back to the folder, which at least keeps
    // one program's pieces together, and show the file name.
    let file = std::path::Path::new(path);
    let label = file
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let key = file
        .parent()
        .map(|d| d.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| label.to_lowercase());
    (key, label)
}

/// Whether this names the platform rather than the program.
///
/// Windows stamps one ProductName across everything it ships, so it is
/// a grouping key that means "made by the OS" rather than "the same
/// application".
fn is_platform_product(product: &str) -> bool {
    let lowered = product.to_lowercase();
    lowered.contains("operating system") || lowered == "microsoft windows"
}

/// The last path segment without its extension, for a display name of
/// last resort.
fn file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// `ProductName` from the executable's version resource.
fn product_name(path: &str) -> Option<String> {
    version_string(path, "ProductName")
}

/// One named string from an executable's version resource.
fn version_string(path: &str, field: &str) -> Option<String> {
    let wide: Vec<u16> = std::ffi::OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a valid null-terminated wide string.
    let size = unsafe { GetFileVersionInfoSizeW(wide.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        return None;
    }
    let mut buffer = vec![0u8; size as usize];
    // SAFETY: the buffer is `size` bytes, which is what the call asked
    // for above.
    if unsafe { GetFileVersionInfoW(wide.as_ptr(), 0, size, buffer.as_mut_ptr() as *mut _) } == 0 {
        return None;
    }

    // The translation table says which language block the strings are
    // in. Assuming one is how this returns nothing for half the
    // machines it runs on.
    let mut lang_ptr: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut lang_len: u32 = 0;
    let translation: Vec<u16> = std::ffi::OsStr::new("\\VarFileInfo\\Translation")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: buffer came from GetFileVersionInfoW; the out params are
    // owned here.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            translation.as_ptr(),
            &mut lang_ptr,
            &mut lang_len,
        )
    };
    if ok == 0 || lang_ptr.is_null() || lang_len < 4 {
        return None;
    }
    // SAFETY: the block is at least one 4-byte language/codepage pair.
    let (language, codepage) = unsafe {
        let pair = lang_ptr as *const u16;
        (*pair, *pair.add(1))
    };

    let query = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\{field}");
    let query: Vec<u16> = std::ffi::OsStr::new(&query)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut value: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut chars: u32 = 0;
    // SAFETY: as above.
    let ok = unsafe {
        VerQueryValueW(
            buffer.as_ptr() as *const _,
            query.as_ptr(),
            &mut value,
            &mut chars,
        )
    };
    if ok == 0 || value.is_null() || chars == 0 {
        return None;
    }
    // SAFETY: `chars` UTF-16 units, trailing null included.
    let text = unsafe { std::slice::from_raw_parts(value as *const u16, chars as usize) };
    let text = String::from_utf16_lossy(text);
    Some(text.trim_end_matches('\0').to_string())
}

/// Whether this is a program a customer would recognise, rather than a
/// part of Windows.
fn is_user_application(path: &str) -> bool {
    let lowered = path.to_lowercase();
    if !lowered.ends_with(".exe") {
        return false;
    }
    // Excluded rather than merely sorted last: a customer who routes
    // svchost through a VPN has not made a choice, they have made a
    // mistake, and an offered list is where that starts.
    const SYSTEM: [&str; 4] = [
        r"\windows\system32\",
        r"\windows\syswow64\",
        r"\windows\winsxs\",
        r"\windows\servicing\",
    ];
    if SYSTEM.iter().any(|dir| lowered.contains(dir)) {
        return false;
    }

    // Traps rather than choices, and each one was really offered.
    //
    // `msedgewebview2.exe` is this application's own window: Tauri runs
    // on WebView2, so it is always in the list, and it sits one letter
    // away from the browser somebody actually means. A tester picked
    // from this list, opened Edge, and reported that Custom mode did
    // nothing -- correctly, because Edge was never what got selected.
    // Edge itself is absent unless it happens to be running, which is
    // what makes the near-miss so easy.
    //
    // The other two are the app and the service. Routing the client
    // that manages the tunnel through its own tunnel is not a setting
    // anybody wants, and the redirect excludes the service anyway --
    // so offering them can only mislead.
    const NEVER_OFFER: [&str; 3] = [
        "msedgewebview2.exe",
        "neoconnect-desktop.exe",
        "neoconnect-service.exe",
    ];
    let file_name = std::path::Path::new(&lowered)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    !NEVER_OFFER.contains(&file_name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case that put scoring here: Edge ships an
    /// `elevation_service.exe` that sorts before `msedge.exe`, and taking
    /// the first put a service's path and icon under "Microsoft Edge".
    #[test]
    fn the_primary_binary_is_the_one_named_after_the_product() {
        let paths = vec![
            r"C:\Program Files (x86)\Microsoft\Edge\Application\elevation_service.exe".to_string(),
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".to_string(),
        ];
        assert_eq!(pick_primary("Microsoft Edge", &paths).as_deref(), Some(paths[1].as_str()));

        // An exact stem beats a longer helper that merely contains it.
        let discord = vec![r"C:\D\Update.exe".to_string(), r"C:\D\Discord.exe".to_string()];
        assert_eq!(pick_primary("Discord", &discord).as_deref(), Some(r"C:\D\Discord.exe"));

        assert_eq!(pick_primary("Anything", &[]), None);
    }

    /// Traps rather than choices, each of which was really offered: the
    /// operating system's own binaries, and the three names one letter
    /// or one click away from a mistake -- WebView2 beside the browser
    /// somebody meant, and this product's own app and service.
    #[test]
    fn the_picker_offers_programs_and_never_the_traps() {
        assert!(is_user_application(r"C:\Program Files\Game\game.exe"));
        assert!(is_user_application(r"D:\Games\Steam\steam.EXE"), "case does not matter");

        assert!(!is_user_application(r"C:\Windows\System32\svchost.exe"));
        assert!(!is_user_application(r"C:\WINDOWS\SysWOW64\cmd.exe"));
        assert!(!is_user_application(r"C:\Program Files\Game\readme.txt"), "not an executable");
        for trap in [
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\msedgewebview2.exe",
            r"C:\Program Files\Neoxify\neoconnect-desktop.exe",
            r"C:\Program Files\Neoxify\neoconnect-service.exe",
        ] {
            assert!(!is_user_application(trap), "{trap} must never be offered");
        }
    }

    /// Windows stamps one ProductName on everything it ships. Grouping on
    /// it once put nine unrelated accessories under a single entry that a
    /// customer selecting it would have tunnelled all of.
    #[test]
    fn the_platform_name_is_not_a_product() {
        assert!(is_platform_product("Microsoft® Windows® Operating System"));
        assert!(is_platform_product("Microsoft Windows"));
        assert!(!is_platform_product("Discord"));
    }

    /// The version-resource path against real binaries, which nothing ran
    /// before. Two Windows accessories share a ProductName and must still
    /// come out as two products, each keyed by its own path.
    #[test]
    fn two_windows_accessories_are_two_products_not_one() {
        let explorer = r"C:\Windows\explorer.exe";
        let notepad = r"C:\Windows\System32\notepad.exe";
        let (explorer_key, explorer_label) = product_of(explorer);
        let (notepad_key, _) = product_of(notepad);
        assert_ne!(explorer_key, notepad_key, "one platform name must not group them");
        assert!(!explorer_label.trim().is_empty(), "a name a person can read");
        assert!(
            version_string(explorer, "ProductName").is_some(),
            "the version resource should be readable from a real binary"
        );
    }
}