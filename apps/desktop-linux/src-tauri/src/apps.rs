//! Custom mode's app picker: from "these programs are running" to "these
//! are apps a person would recognise".
//!
//! The helper is root and lists the caller's processes grouped by program
//! path, because the path is what Custom mode sorts on. That list is every
//! shell, daemon and helper the session runs. What a person means by "an
//! app" is what their launcher shows them, and the launcher's list is the
//! installed desktop entries, so a program is offered only when one of
//! those entries is its, and it is offered under that entry's name and
//! icon. The entries and icons are the user's own files, read here as the
//! user rather than by the helper.
//!
//! A program is tied to its entry in three ways, most certain first: the
//! systemd unit the launcher started it in (which carries the entry's id,
//! and is the only way to recognise a flatpak, whose program path is the
//! sandbox's), the entry's own program being the running one, and the
//! running program living in the entry program's own directory (a wrapper
//! script in /usr/bin starting the real binary in /opt or /usr/lib).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use neoconnect_ipc::RunningApp;

/// An icon file larger than this is not opened: no app icon needs it, and
/// the list is read while the picker waits.
const MAX_ICON_BYTES: u64 = 1024 * 1024;

/// The size icons are redrawn at: twice a picker row's, for sharp edges on
/// a scaled screen, and small enough to send as JSON.
const ICON_PIXELS: i32 = 64;

/// Icon sizes to look for, the ones that look right in a picker row first.
const ICON_SIZES: [&str; 8] = ["48x48", "64x64", "96x96", "128x128", "32x32", "256x256", "24x24", "512x512"];

/// One installed desktop entry, as far as the picker needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    /// The desktop file id: its path under `applications/`, `/` as `-`,
    /// without `.desktop`.
    pub id: String,
    pub name: String,
    /// The program `Exec` starts, as written (after `env` and its
    /// assignments), when it names one.
    pub program: Option<String>,
    pub icon: Option<String>,
    /// The snap this entry belongs to (`X-SnapInstanceName`).
    pub snap: Option<String>,
    /// The flatpak application id (`X-Flatpak`).
    pub flatpak: Option<String>,
    /// `NoDisplay` or `Hidden`: the launcher does not show it, so neither
    /// does the picker. Kept rather than dropped so a user's own hidden
    /// copy still masks the system's entry of the same id.
    pub hidden: bool,
}

/// The helper's list, turned into what the picker shows. Never fails: an
/// unreadable directory is an app that is not recognised, not an error.
pub(crate) fn presentable(running: Vec<RunningApp>) -> Vec<RunningApp> {
    let env = Env::from_process();
    let langs = languages(&env);
    let entries = installed_entries(&env.data_dirs(), &langs);
    let own_exe = std::env::current_exe().ok().and_then(|p| std::fs::canonicalize(p).ok());
    let own_pid = std::process::id();
    let path_dirs = env.path_dirs();
    let resolved: HashMap<String, Vec<PathBuf>> = entries
        .iter()
        .filter_map(|e| e.program.as_ref())
        .map(|p| (p.clone(), resolve_program(p, &path_dirs)))
        .collect();

    // Grouped by entry: one app can be several programs (a browser and
    // its sandbox helper), and the person means all of them.
    let mut chosen: Vec<(usize, RunningApp)> = Vec::new();
    for app in running {
        if app.pids.contains(&own_pid)
            || own_exe.as_ref().is_some_and(|own| identity_paths(&app).iter().any(|p| Path::new(p) == own))
        {
            continue;
        }
        let units: Vec<String> = app.pids.iter().filter_map(|pid| unit_of(*pid)).collect();
        let Some(index) = best_entry(&entries, &resolved, &app, &units, &env.home) else {
            continue;
        };
        if entries[index].id.to_ascii_lowercase().starts_with("neoxify") {
            continue;
        }
        match chosen.iter_mut().find(|(i, _)| *i == index) {
            Some((_, merged)) => merge(merged, &app),
            None => {
                let mut shown = app.clone();
                shown.paths = identity_paths(&app);
                shown.name = entries[index].name.clone();
                shown.icon = None;
                chosen.push((index, shown));
            }
        }
    }
    let mut out: Vec<RunningApp> = chosen
        .into_iter()
        .map(|(index, mut app)| {
            app.icon = entries[index].icon.as_deref().and_then(|icon| load_icon(icon, &env.data_dirs()));
            app
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Every path one helper entry stands for, its own first.
fn identity_paths(app: &RunningApp) -> Vec<String> {
    let mut all = vec![app.path.clone()];
    for p in &app.paths {
        if !all.contains(p) {
            all.push(p.clone());
        }
    }
    all
}

fn merge(into: &mut RunningApp, more: &RunningApp) {
    // The program shown is the one running the most processes: a browser
    // rather than its crash reporter.
    if more.pids.len() > into.pids.len() {
        into.path = more.path.clone();
    }
    for p in identity_paths(more) {
        if !into.paths.contains(&p) {
            into.paths.push(p);
        }
    }
    for pid in &more.pids {
        if !into.pids.contains(pid) {
            into.pids.push(*pid);
        }
    }
}

/// The entry this running program belongs to, if any, by the most certain
/// tie that holds. Hidden entries are never chosen.
pub(crate) fn best_entry(
    entries: &[Entry],
    resolved: &HashMap<String, Vec<PathBuf>>,
    app: &RunningApp,
    units: &[String],
    home: &Option<PathBuf>,
) -> Option<usize> {
    let paths = identity_paths(app);
    let mut best: Option<(u8, usize)> = None;
    for (i, entry) in entries.iter().enumerate() {
        if entry.hidden {
            continue;
        }
        let score = tie(entry, resolved, &paths, units, home);
        if score > 0 && best.is_none_or(|(s, _)| score > s) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| i)
}

/// How certainly `entry` is this program: 0 not at all, higher is surer.
fn tie(
    entry: &Entry,
    resolved: &HashMap<String, Vec<PathBuf>>,
    paths: &[String],
    units: &[String],
    home: &Option<PathBuf>,
) -> u8 {
    for unit in units {
        if unit_names_entry(unit, entry) {
            return 4;
        }
    }
    let programs: &[PathBuf] = entry.program.as_ref().and_then(|p| resolved.get(p)).map(Vec::as_slice).unwrap_or(&[]);
    if programs.iter().any(|prog| paths.iter().any(|p| Path::new(p) == prog)) {
        return 3;
    }
    if let Some(snap) = &entry.snap {
        let root = format!("/snap/{snap}/");
        if paths.iter().any(|p| p.starts_with(&root)) {
            return 2;
        }
    }
    for prog in programs {
        if let Some(dir) = program_home(prog, home) {
            if paths.iter().any(|p| Path::new(p).starts_with(&dir)) {
                return 1;
            }
        }
    }
    0
}

/// The id a systemd unit's name says it was started for, as launchers name
/// them (`app-gnome-org.gnome.Nautilus-1234.scope`,
/// `app-flatpak-org.mozilla.firefox-5678.scope`,
/// `snap.firefox.firefox-<uuid>.scope`), checked against one entry.
fn unit_names_entry(unit: &str, entry: &Entry) -> bool {
    match parse_unit(unit) {
        Some(Unit::Snap { snap, app }) => {
            entry.id == format!("{snap}_{app}") || (entry.snap.as_deref() == Some(snap.as_str()) && snap == app)
        }
        Some(Unit::Flatpak(id)) => entry.flatpak.as_deref() == Some(id.as_str()) || entry.id == id,
        Some(Unit::App(candidates)) => candidates.iter().any(|c| *c == entry.id),
        None => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Unit {
    Snap { snap: String, app: String },
    Flatpak(String),
    /// The possible desktop ids: with and without a launcher prefix,
    /// which the name alone cannot tell apart.
    App(Vec<String>),
}

/// Reads the systemd naming convention for applications
/// (`app-[<launcher>-]<id>[@<random>].service`,
/// `app-[<launcher>-]<id>-<random>.scope`), in which a `-` inside the id is
/// escaped as `\x2d`, so an unescaped `-` is always a separator.
pub(crate) fn parse_unit(unit: &str) -> Option<Unit> {
    let (stem, scope) = if let Some(s) = unit.strip_suffix(".scope") {
        (s, true)
    } else {
        (unit.strip_suffix(".service")?, false)
    };
    if let Some(rest) = stem.strip_prefix("snap.") {
        let (snap, app) = rest.split_once('.')?;
        // `<app>-<uuid>` for a scope, where both may hold dashes; the
        // uuid's fixed length is what finds the seam.
        let app = match app.len().checked_sub(37) {
            Some(cut) if app.as_bytes()[cut] == b'-' && looks_like_uuid(&app[cut + 1..]) => &app[..cut],
            _ if scope => app.rsplit_once('-').map_or(app, |(a, _)| a),
            _ => app,
        };
        return Some(Unit::Snap { snap: snap.to_string(), app: app.to_string() });
    }
    let rest = stem.strip_prefix("app-")?;
    let rest = match rest.split_once('@') {
        Some((before, _)) => before,
        None if scope => rest.rsplit_once('-').map(|(before, _)| before)?,
        None => rest,
    };
    if let Some(id) = rest.strip_prefix("flatpak-") {
        return Some(Unit::Flatpak(unescape(id)));
    }
    let mut candidates = vec![unescape(rest)];
    if let Some((_, after)) = rest.split_once('-') {
        candidates.push(unescape(after));
    }
    Some(Unit::App(candidates))
}

fn looks_like_uuid(s: &str) -> bool {
    s.len() == 36 && s.chars().all(|c| c == '-' || c.is_ascii_hexdigit()) && s.matches('-').count() == 4
}

fn unescape(s: &str) -> String {
    s.replace("\\x2d", "-")
}

/// The last unit in a process's control-group path, from
/// `/proc/<pid>/cgroup`, which any user may read for their own processes.
fn unit_of(pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    unit_from_cgroup(&text)
}

pub(crate) fn unit_from_cgroup(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.starts_with("0::"))?;
    let last = line[3..].rsplit('/').next()?;
    (last.ends_with(".scope") || last.ends_with(".service")).then(|| last.to_string())
}

/// The directory a program is installed into, when it has one of its own:
/// `/usr/share/code` for `/usr/share/code/bin/code`, `/opt/google/chrome`
/// for its launcher script. `None` for shared directories (`/usr/bin`,
/// `~/.local`), where "lives in the same place" would tie unrelated
/// programs together.
pub(crate) fn program_home(program: &Path, home: &Option<PathBuf>) -> Option<PathBuf> {
    let mut dir = program.parent()?.to_path_buf();
    if matches!(dir.file_name().and_then(|n| n.to_str()), Some("bin" | "sbin")) {
        dir = dir.parent()?.to_path_buf();
    }
    let parts = dir.components().count() - 1; // without the root
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let own = parts >= 3 || (parts == 2 && dir.starts_with("/opt"));
    let shared = matches!(name, "bin" | "sbin" | "libexec" | "lib" | "lib64" | "share" | "local" | ".local")
        || name.ends_with("-linux-gnu")
        || home.as_ref().is_some_and(|h| h.starts_with(&dir) || dir == h.join(".local") || dir == h.join(".local/share"));
    (own && !shared).then_some(dir)
}

/// Where a program named in `Exec` really is: each spelling the running
/// program could be reported by (the path found, and where its links
/// lead).
fn resolve_program(program: &str, path_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let found = if program.starts_with('/') {
        Some(PathBuf::from(program))
    } else if program.contains('/') {
        None
    } else {
        path_dirs.iter().map(|d| d.join(program)).find(|p| p.is_file())
    };
    let Some(found) = found else { return Vec::new() };
    let mut all = vec![found.clone()];
    if let Ok(real) = std::fs::canonicalize(&found) {
        if real != found {
            all.push(real);
        }
    }
    all
}

/// The parts of the environment this module reads, gathered once so the
/// rest can be tested without one.
pub(crate) struct Env {
    pub home: Option<PathBuf>,
    pub data_home: Option<PathBuf>,
    pub data_dirs: Option<String>,
    pub path: Option<String>,
    pub language: Option<String>,
    pub locale: Option<String>,
}

impl Env {
    fn from_process() -> Env {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Env {
            home: var("HOME").map(PathBuf::from),
            data_home: var("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()),
            data_dirs: var("XDG_DATA_DIRS"),
            path: var("PATH"),
            language: var("LANGUAGE"),
            locale: var("LC_ALL").or_else(|| var("LC_MESSAGES")).or_else(|| var("LANG")),
        }
    }

    /// The XDG data directories, most important first, with the places
    /// snap and flatpak put their entries added in case the session's
    /// variable does not name them.
    pub(crate) fn data_dirs(&self) -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(h) = self.data_home.clone().or_else(|| self.home.as_ref().map(|h| h.join(".local/share"))) {
            dirs.push(h);
        }
        let system = self.data_dirs.clone().unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
        dirs.extend(system.split(':').filter(|d| d.starts_with('/')).map(PathBuf::from));
        if let Some(h) = &self.home {
            dirs.push(h.join(".local/share/flatpak/exports/share"));
        }
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
        dirs.push(PathBuf::from("/var/lib/snapd/desktop"));
        let mut seen = Vec::new();
        dirs.retain(|d| {
            let fresh = !seen.contains(d);
            seen.push(d.clone());
            fresh
        });
        dirs
    }

    fn path_dirs(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> =
            self.path.as_deref().unwrap_or("").split(':').filter(|d| d.starts_with('/')).map(PathBuf::from).collect();
        for d in ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"] {
            if !dirs.iter().any(|x| x == Path::new(d)) {
                dirs.push(PathBuf::from(d));
            }
        }
        dirs
    }
}

/// The locale names a localized key may carry, best first, as the desktop
/// entry specification orders them: `lang_COUNTRY@MODIFIER`,
/// `lang_COUNTRY`, `lang@MODIFIER`, `lang`.
pub(crate) fn languages(env: &Env) -> Vec<String> {
    let mut out = Vec::new();
    let mut add = |locale: &str| {
        let locale = locale.split('.').next().unwrap_or("");
        let (base, modifier) = match locale.split_once('@') {
            Some((b, m)) => (b, Some(m)),
            None => (locale, None),
        };
        // The '.' cut above also drops a modifier written after the
        // encoding (`fa_IR.UTF-8@x`); that spelling is not in use.
        if base.is_empty() || base == "C" || base == "POSIX" {
            return;
        }
        let lang = base.split('_').next().unwrap_or(base);
        let mut candidates = Vec::new();
        if let Some(m) = modifier {
            candidates.push(format!("{base}@{m}"));
        }
        candidates.push(base.to_string());
        if let Some(m) = modifier {
            candidates.push(format!("{lang}@{m}"));
        }
        candidates.push(lang.to_string());
        for c in candidates {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    };
    if let Some(list) = &env.language {
        for l in list.split(':') {
            add(l);
        }
    }
    if let Some(l) = &env.locale {
        add(l);
    }
    out
}

/// Every desktop entry under `<dir>/applications`, the first of each id
/// winning, as the specification has it.
fn installed_entries(data_dirs: &[PathBuf], langs: &[String]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    for dir in data_dirs {
        let apps = dir.join("applications");
        let mut files = Vec::new();
        collect_desktop_files(&apps, &apps, 0, &mut files);
        for (id, file) in files {
            if entries.iter().any(|e| e.id == id) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if meta.len() > 256 * 1024 {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            if let Some(entry) = parse_entry(&id, &text, langs, &|domain, msgid| translated(domain, msgid, langs)) {
                entries.push(entry);
            }
        }
    }
    entries
}

fn collect_desktop_files(root: &Path, dir: &Path, depth: u8, out: &mut Vec<(String, PathBuf)>) {
    if depth > 3 {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for item in read.flatten() {
        let path = item.path();
        let Ok(kind) = item.file_type() else { continue };
        if kind.is_dir() {
            collect_desktop_files(root, &path, depth + 1, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("desktop") {
            if let Some(id) = desktop_id(root, &path) {
                out.push((id, path));
            }
        }
    }
}

pub(crate) fn desktop_id(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?.to_str()?;
    Some(rel.strip_suffix(".desktop")?.replace('/', "-"))
}

/// Reads the `[Desktop Entry]` group of one file. `None` for anything
/// that is not an application with a name.
pub(crate) fn parse_entry(
    id: &str,
    text: &str,
    langs: &[String],
    translate: &dyn Fn(&str, &str) -> Option<String>,
) -> Option<Entry> {
    let mut in_group = false;
    let mut plain: HashMap<&str, &str> = HashMap::new();
    let mut localized: HashMap<(&str, &str), &str> = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        match key.split_once('[') {
            Some((k, rest)) => {
                if let Some(locale) = rest.strip_suffix(']') {
                    localized.entry((k, locale)).or_insert(value);
                }
            }
            None => {
                plain.entry(key).or_insert(value);
            }
        }
    }
    if plain.get("Type").copied() != Some("Application") {
        return None;
    }
    let untranslated = plain.get("Name").map(|n| unescape_value(n)).filter(|n| !n.is_empty())?;
    // Ubuntu strips the translations out of its entries and names a
    // gettext catalogue instead, which the launcher reads.
    let name = langs
        .iter()
        .find_map(|l| localized.get(&("Name", l.as_str())))
        .map(|n| unescape_value(n))
        .filter(|n| !n.is_empty())
        .or_else(|| {
            let domain = plain.get("X-Ubuntu-Gettext-Domain").or_else(|| plain.get("X-GNOME-Gettext-Domain"))?;
            translate(domain, &untranslated)
        })
        .unwrap_or(untranslated);
    let flag = |k: &str| plain.get(k).is_some_and(|v| v.eq_ignore_ascii_case("true"));
    let text_of = |k: &str| plain.get(k).map(|v| unescape_value(v)).filter(|v| !v.is_empty());
    Some(Entry {
        id: id.to_string(),
        name,
        program: plain.get("Exec").and_then(|e| exec_program(e)),
        icon: text_of("Icon"),
        snap: text_of("X-SnapInstanceName"),
        flatpak: text_of("X-Flatpak"),
        hidden: flag("NoDisplay") || flag("Hidden"),
    })
}

/// A name from the gettext catalogue an entry names, for the first
/// language that has one installed.
fn translated(domain: &str, msgid: &str, langs: &[String]) -> Option<String> {
    if domain.is_empty() || domain.contains('/') || domain.starts_with('.') {
        return None;
    }
    for lang in langs {
        for root in ["/usr/share/locale-langpack", "/usr/share/locale"] {
            let file = Path::new(root).join(lang).join("LC_MESSAGES").join(format!("{domain}.mo"));
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            if meta.len() > 8 * 1024 * 1024 {
                continue;
            }
            let Ok(bytes) = std::fs::read(&file) else { continue };
            if let Some(found) = mo_lookup(&bytes, msgid) {
                return Some(found);
            }
        }
    }
    None
}

/// Looks one message up in a compiled gettext catalogue (the GNU `.mo`
/// format: a header, then two tables of length and offset pairs).
pub(crate) fn mo_lookup(bytes: &[u8], msgid: &str) -> Option<String> {
    let word = |at: usize, big: bool| -> Option<u32> {
        let b: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if big { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    };
    let big = match word(0, false)? {
        0x9504_12de => false,
        0xde12_0495 => true,
        _ => return None,
    };
    let count = word(8, big)? as usize;
    let originals = word(12, big)? as usize;
    let translations = word(16, big)? as usize;
    let string = |table: usize, i: usize| -> Option<&[u8]> {
        let len = word(table + i * 8, big)? as usize;
        let at = word(table + i * 8 + 4, big)? as usize;
        bytes.get(at..at.checked_add(len)?)
    };
    for i in 0..count.min(1_000_000) {
        if string(originals, i)? == msgid.as_bytes() {
            let text = std::str::from_utf8(string(translations, i)?).ok()?;
            // Plural forms are separated by NULs; a name has one.
            return text.split('\0').next().filter(|t| !t.is_empty()).map(str::to_string);
        }
    }
    None
}

/// The escapes a string value may carry (`\s`, `\n`, `\t`, `\r`, `\\`).
fn unescape_value(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// The program an `Exec` line starts: its first word, quotes honoured,
/// after `env` and the variables it sets (snap entries start
/// `env BAMF_DESKTOP_FILE_HINT=... /snap/bin/firefox %u`).
pub(crate) fn exec_program(exec: &str) -> Option<String> {
    let words = exec_words(&unescape_value(exec));
    let mut rest = words.iter().map(String::as_str);
    let mut first = rest.next()?;
    if first == "env" || first.ends_with("/env") {
        first = rest.find(|w| !w.contains('=') && !w.starts_with('-'))?;
    }
    (!first.is_empty() && !first.starts_with('%')).then(|| first.to_string())
}

fn exec_words(exec: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true;
            }
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    word.push(n);
                }
            }
            ' ' | '\t' if !quoted => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            _ => {
                word.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(word);
    }
    words
}

/// An entry's icon as base64 PNG, the encoding the picker draws
/// (`data:image/png;base64,...` in RunningAppPicker.tsx). Every icon is
/// redrawn at one size through gdk-pixbuf, which Tauri's GTK already
/// brings: most GNOME apps ship only an SVG, which the picker could not
/// draw as it is, and a 512-pixel PNG is a lot to send for a list row.
/// With no icon found the picker shows the name's first letter.
fn load_icon(icon: &str, data_dirs: &[PathBuf]) -> Option<String> {
    let drawable = |p: &Path| matches!(p.extension().and_then(|e| e.to_str()), Some("png" | "svg"));
    let file = if icon.starts_with('/') {
        Some(PathBuf::from(icon)).filter(|p| drawable(p) && p.is_file())
    } else {
        let name = icon.strip_suffix(".png").or_else(|| icon.strip_suffix(".svg")).unwrap_or(icon);
        if name.contains('/') {
            return None;
        }
        icon_candidates(name, data_dirs).into_iter().find(|p| p.is_file())
    }?;
    if std::fs::metadata(&file).ok()?.len() > MAX_ICON_BYTES {
        return None;
    }
    let pixbuf = gtk::gdk_pixbuf::Pixbuf::from_file_at_scale(&file, ICON_PIXELS, ICON_PIXELS, true).ok()?;
    let png = pixbuf.save_to_bufferv("png", &[]).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(png))
}

fn icon_candidates(name: &str, data_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in data_dirs {
        let hicolor = dir.join("icons/hicolor");
        for size in ICON_SIZES {
            out.push(hicolor.join(size).join("apps").join(format!("{name}.png")));
        }
        out.push(hicolor.join("scalable/apps").join(format!("{name}.svg")));
    }
    out.push(PathBuf::from(format!("/usr/share/pixmaps/{name}.png")));
    out.push(PathBuf::from(format!("/usr/share/pixmaps/{name}.svg")));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn langs(locale: &str) -> Vec<String> {
        languages(&Env {
            home: None,
            data_home: None,
            data_dirs: None,
            path: None,
            language: None,
            locale: Some(locale.into()),
        })
    }

    const FIREFOX_SNAP: &str = "[Desktop Entry]\nVersion=1.0\nName=Firefox Web Browser\nName[fa]=مرورگر فایرفاکس\nExec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u\nIcon=/snap/firefox/1234/default256.png\nType=Application\nX-SnapInstanceName=firefox\n\n[Desktop Action new-window]\nName=New Window\nExec=/snap/bin/other\n";

    #[test]
    fn locale_names_are_tried_in_the_specifications_order() {
        assert_eq!(langs("fa_IR.UTF-8"), vec!["fa_IR", "fa"]);
        assert_eq!(langs("sr_RS@latin"), vec!["sr_RS@latin", "sr_RS", "sr@latin", "sr"]);
        assert!(langs("C.UTF-8").is_empty());
    }

    #[test]
    fn an_entry_is_read_from_its_own_group_with_the_localized_name() {
        let e = parse_entry("firefox_firefox", FIREFOX_SNAP, &langs("fa_IR.UTF-8"), &no_catalogue).unwrap();
        assert_eq!(e.name, "مرورگر فایرفاکس");
        assert_eq!(e.program.as_deref(), Some("/snap/bin/firefox"));
        assert_eq!(e.snap.as_deref(), Some("firefox"));
        assert!(!e.hidden);
        let e = parse_entry("firefox_firefox", FIREFOX_SNAP, &langs("en_US.UTF-8"), &no_catalogue).unwrap();
        assert_eq!(e.name, "Firefox Web Browser");
    }

    #[test]
    fn what_is_not_a_shown_application_is_marked_or_refused() {
        assert!(parse_entry("x", "[Desktop Entry]\nType=Link\nName=X\nURL=https://example.com\n", &[], &no_catalogue).is_none());
        assert!(parse_entry("x", "[Desktop Entry]\nType=Application\nExec=x\n", &[], &no_catalogue).is_none());
        let e = parse_entry("x", "[Desktop Entry]\nType=Application\nName=X\nExec=x\nNoDisplay=true\n", &[], &no_catalogue).unwrap();
        assert!(e.hidden);
        let e = parse_entry("x", "[Desktop Entry]\nType=Application\nName=X\nExec=x\nHidden=True\n", &[], &no_catalogue).unwrap();
        assert!(e.hidden);
    }

    #[test]
    fn the_program_is_the_first_word_after_env_and_quotes() {
        assert_eq!(exec_program("\"/opt/My App/run\" --flag %U").as_deref(), Some("/opt/My App/run"));
        assert_eq!(exec_program("code --new-window %F").as_deref(), Some("code"));
        assert_eq!(exec_program("env GDK_BACKEND=x11 FOO=1 /usr/bin/thing").as_deref(), Some("/usr/bin/thing"));
        assert_eq!(exec_program("/usr/bin/flatpak run --command=x org.example.App").as_deref(), Some("/usr/bin/flatpak"));
        assert_eq!(exec_program("").as_deref(), None);
    }

    #[test]
    fn launcher_units_name_the_entry() {
        assert_eq!(
            parse_unit("app-gnome-org.gnome.Nautilus-4242.scope"),
            Some(Unit::App(vec!["gnome-org.gnome.Nautilus".into(), "org.gnome.Nautilus".into()]))
        );
        assert_eq!(
            parse_unit("app-gnome-google\\x2dchrome-4242.scope"),
            Some(Unit::App(vec!["gnome-google-chrome".into(), "google-chrome".into()]))
        );
        assert_eq!(parse_unit("app-org.kde.dolphin@0a1b2c.service"), Some(Unit::App(vec!["org.kde.dolphin".into()])));
        assert_eq!(parse_unit("app-flatpak-org.mozilla.firefox-77.scope"), Some(Unit::Flatpak("org.mozilla.firefox".into())));
        assert_eq!(
            parse_unit("snap.firefox.firefox-0f2c1d.scope"),
            Some(Unit::Snap { snap: "firefox".into(), app: "firefox".into() })
        );
        assert_eq!(
            parse_unit("snap.telegram-desktop.telegram-desktop-3b4c9d2e-1f2a-4b5c-8d9e-0a1b2c3d4e5f.scope"),
            Some(Unit::Snap { snap: "telegram-desktop".into(), app: "telegram-desktop".into() })
        );
        assert_eq!(parse_unit("vte-spawn-1234.scope"), None);
        assert_eq!(parse_unit("session-2.scope"), None);
        let cg = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-org.gnome.Nautilus-4242.scope\n";
        assert_eq!(unit_from_cgroup(cg).as_deref(), Some("app-gnome-org.gnome.Nautilus-4242.scope"));
        assert_eq!(unit_from_cgroup("0::/neoxify.split\n"), None);
    }

    #[test]
    fn a_programs_own_directory_is_its_home_and_shared_ones_are_not() {
        let home = Some(PathBuf::from("/home/u"));
        assert_eq!(program_home(Path::new("/usr/share/code/bin/code"), &home), Some(PathBuf::from("/usr/share/code")));
        assert_eq!(program_home(Path::new("/opt/google/chrome/google-chrome"), &home), Some(PathBuf::from("/opt/google/chrome")));
        assert_eq!(program_home(Path::new("/opt/Signal/signal-desktop"), &home), Some(PathBuf::from("/opt/Signal")));
        assert_eq!(program_home(Path::new("/usr/bin/firefox"), &home), None);
        assert_eq!(program_home(Path::new("/usr/local/bin/x"), &home), None);
        assert_eq!(program_home(Path::new("/usr/lib/x86_64-linux-gnu/x"), &home), None);
        assert_eq!(program_home(Path::new("/home/u/.local/bin/x"), &home), None);
        assert_eq!(program_home(Path::new("/home/u/x"), &home), None);
    }

    fn running(path: &str, pids: &[u32]) -> RunningApp {
        RunningApp { path: path.into(), name: "x".into(), paths: vec![path.into()], icon: None, pids: pids.to_vec() }
    }

    fn entry(id: &str, program: Option<&str>) -> Entry {
        Entry {
            id: id.into(),
            name: id.into(),
            program: program.map(str::to_string),
            icon: None,
            snap: None,
            flatpak: None,
            hidden: false,
        }
    }

    #[test]
    fn programs_are_tied_to_entries_by_the_surest_tie() {
        let entries = vec![
            entry("code", Some("/usr/bin/code")),
            entry("firefox", Some("firefox")),
            Entry { snap: Some("telegram-desktop".into()), ..entry("telegram-desktop_telegram-desktop", Some("/snap/bin/telegram-desktop")) },
            Entry { flatpak: Some("org.example.Chat".into()), ..entry("org.example.Chat", Some("/usr/bin/flatpak")) },
            Entry { hidden: true, ..entry("hidden", Some("/usr/bin/hidden")) },
        ];
        let mut resolved = HashMap::new();
        resolved.insert("/usr/bin/code".to_string(), vec![PathBuf::from("/usr/bin/code"), PathBuf::from("/usr/share/code/bin/code")]);
        resolved.insert("firefox".to_string(), vec![PathBuf::from("/usr/bin/firefox"), PathBuf::from("/usr/lib/firefox/firefox")]);
        resolved.insert("/usr/bin/hidden".to_string(), vec![PathBuf::from("/usr/bin/hidden")]);
        let home = Some(PathBuf::from("/home/u"));
        let pick = |app: RunningApp, units: &[&str]| {
            let units: Vec<String> = units.iter().map(|u| u.to_string()).collect();
            best_entry(&entries, &resolved, &app, &units, &home).map(|i| entries[i].id.clone())
        };
        // Its own program, through the link.
        assert_eq!(pick(running("/usr/lib/firefox/firefox", &[1]), &[]).as_deref(), Some("firefox"));
        // In the wrapper script's own directory.
        assert_eq!(pick(running("/usr/share/code/code", &[2]), &[]).as_deref(), Some("code"));
        // A snap, by where snaps live.
        assert_eq!(pick(running("/snap/telegram-desktop/99/usr/bin/telegram", &[3]), &[]).as_deref(), Some("telegram-desktop_telegram-desktop"));
        // A flatpak, only by the unit the launcher started it in.
        assert_eq!(pick(running("/app/bin/chat", &[4]), &["app-flatpak-org.example.Chat-12.scope"]).as_deref(), Some("org.example.Chat"));
        assert_eq!(pick(running("/app/bin/chat", &[4]), &[]), None);
        // A shell has no entry; a hidden entry is never chosen.
        assert_eq!(pick(running("/usr/bin/bash", &[5]), &[]), None);
        assert_eq!(pick(running("/usr/bin/hidden", &[6]), &[]), None);
    }

    /// Against this machine: this user's processes grouped by program, as
    /// the helper does, through the real entries and icons. Prints what
    /// the picker would show. `cargo test -- --ignored --nocapture
    /// this_machines_apps`.
    #[test]
    #[ignore]
    fn this_machines_apps() {
        let uid = unsafe { libc::getuid() };
        let mut by_path: HashMap<String, RunningApp> = HashMap::new();
        for item in std::fs::read_dir("/proc").unwrap().flatten() {
            let Ok(pid) = item.file_name().to_string_lossy().parse::<u32>() else { continue };
            use std::os::unix::fs::MetadataExt;
            if item.metadata().map(|m| m.uid()).ok() != Some(uid) {
                continue;
            }
            let Ok(exe) = std::fs::read_link(format!("/proc/{pid}/exe")) else { continue };
            let path = exe.to_string_lossy().into_owned();
            by_path.entry(path.clone()).or_insert_with(|| running(&path, &[])).pids.push(pid);
        }
        for app in presentable(by_path.into_values().collect()) {
            println!("{} | {} | {} paths | icon {}", app.name, app.path, app.paths.len(), app.icon.map_or(0, |i| i.len()));
        }
    }

    fn no_catalogue(_: &str, _: &str) -> Option<String> {
        None
    }

    /// A catalogue as msgfmt lays one out, little-endian.
    fn catalogue(pairs: &[(&str, &str)]) -> Vec<u8> {
        let n = pairs.len() as u32;
        let originals = 28u32;
        let translations = originals + 8 * n;
        let mut strings = Vec::new();
        let mut table_o = Vec::new();
        let mut table_t = Vec::new();
        let base = translations + 8 * n;
        for (o, _) in pairs {
            table_o.push((o.len() as u32, base + strings.len() as u32));
            strings.extend_from_slice(o.as_bytes());
            strings.push(0);
        }
        for (_, t) in pairs {
            table_t.push((t.len() as u32, base + strings.len() as u32));
            strings.extend_from_slice(t.as_bytes());
            strings.push(0);
        }
        let mut out = Vec::new();
        for w in [0x9504_12de_u32, 0, n, originals, translations, 0, 0] {
            out.extend_from_slice(&w.to_le_bytes());
        }
        for (len, at) in table_o.into_iter().chain(table_t) {
            out.extend_from_slice(&len.to_le_bytes());
            out.extend_from_slice(&at.to_le_bytes());
        }
        out.extend_from_slice(&strings);
        out
    }

    #[test]
    fn an_ubuntu_entry_is_named_from_its_catalogue() {
        let mo = catalogue(&[("Calculator", "ماشین حساب"), ("Files", "پرونده‌ها")]);
        assert_eq!(mo_lookup(&mo, "Calculator").as_deref(), Some("ماشین حساب"));
        assert_eq!(mo_lookup(&mo, "Missing"), None);
        assert_eq!(mo_lookup(b"not a catalogue", "Calculator"), None);
        assert_eq!(mo_lookup(&mo[..30], "Calculator"), None);
        let text = "[Desktop Entry]\nType=Application\nName=Calculator\nExec=gnome-calculator\nX-Ubuntu-Gettext-Domain=gnome-calculator\n";
        let e = parse_entry("org.gnome.Calculator", text, &langs("fa_IR.UTF-8"), &|domain, msgid| {
            assert_eq!(domain, "gnome-calculator");
            mo_lookup(&mo, msgid)
        })
        .unwrap();
        assert_eq!(e.name, "ماشین حساب");
    }

    #[test]
    fn desktop_ids_join_subdirectories_with_dashes() {
        let root = Path::new("/usr/share/applications");
        assert_eq!(desktop_id(root, Path::new("/usr/share/applications/kde4/kate.desktop")).as_deref(), Some("kde4-kate"));
        assert_eq!(desktop_id(root, Path::new("/usr/share/applications/org.gnome.Nautilus.desktop")).as_deref(), Some("org.gnome.Nautilus"));
    }

    #[test]
    fn data_dirs_put_the_users_own_first_and_add_snap_and_flatpak() {
        let env = Env {
            home: Some(PathBuf::from("/home/u")),
            data_home: None,
            data_dirs: Some("/usr/share:/usr/share:relative".into()),
            path: None,
            language: None,
            locale: None,
        };
        let dirs = env.data_dirs();
        assert_eq!(dirs[0], PathBuf::from("/home/u/.local/share"));
        assert_eq!(dirs[1], PathBuf::from("/usr/share"));
        assert_eq!(dirs.iter().filter(|d| *d == Path::new("/usr/share")).count(), 1);
        assert!(dirs.contains(&PathBuf::from("/var/lib/snapd/desktop")));
        assert!(dirs.contains(&PathBuf::from("/var/lib/flatpak/exports/share")));
    }
}
