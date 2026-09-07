//! The save file.
//!
//! A game that keeps its campaign in `localStorage` keeps it in a WebView2
//! cache directory - somewhere the player cannot find, cannot back up, and
//! that Windows, Edge or a "clear browsing data" sweep may empty without
//! asking. Seven chapters is too much to lose that way.
//!
//! So the save is a real file, next to the player's other game data:
//!
//!     %APPDATA%\com.synx.racing\synx-save.json
//!
//! It is plain JSON and it is pretty-printed on purpose. A save file that can
//! be opened, read and understood is one a player can back up before trying
//! something, copy to another machine, or send with a bug report.
//!
//! # Writing it safely
//!
//! The file is written to a temporary sibling and then renamed over the real
//! one. `rename` within a directory is atomic on Windows and on POSIX, so the
//! save on disk is always either the whole of the previous one or the whole of
//! the new one - never the half of a new one that a crash or a power cut
//! happened to interrupt. A truncated save is worse than a stale save, because
//! a stale save still loads.
//!
//! A `.bak` of the previous good file is kept beside it for the same reason:
//! it costs a few kilobytes and it is the difference between "reload your last
//! session" and "start the campaign again".

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the file looks like on disk.
///
/// `entries` holds the game's own namespaced keys - `synx.story.v2`,
/// `synx.settings.v1` and the rest - with their values stored as real JSON
/// rather than as escaped strings. The browser build wrote
/// `"synx.settings.v1": "{\"quality\":2}"`, a JSON document inside a JSON
/// string, which is unreadable for no benefit.
#[derive(Serialize, Deserialize, Default)]
pub struct SaveFile {
    /// Format version, so a future change can migrate rather than discard.
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub app: String,
    /// When it was last written, for the player's benefit rather than ours.
    #[serde(default)]
    pub saved: String,
    #[serde(default)]
    pub entries: serde_json::Map<String, serde_json::Value>,
}

fn one() -> u32 {
    1
}

pub const FILE_NAME: &str = "synx-save.json";
pub const BACKUP_NAME: &str = "synx-save.bak.json";

pub fn dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let d = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&d).ok()?;
    Some(d)
}

pub fn path(app: &tauri::AppHandle) -> Option<PathBuf> {
    Some(dir(app)?.join(FILE_NAME))
}

fn read_at(p: &Path) -> Option<SaveFile> {
    let text = fs::read_to_string(p).ok()?;
    serde_json::from_str(&text).ok()
}

/// Load the save, falling back to the backup if the main file is unreadable.
pub fn load(app: &tauri::AppHandle) -> SaveFile {
    let Some(d) = dir(app) else { return SaveFile::default() };
    if let Some(s) = read_at(&d.join(FILE_NAME)) {
        return s;
    }
    // The main file is missing or corrupt. A backup that loads beats a
    // campaign that does not.
    if let Some(s) = read_at(&d.join(BACKUP_NAME)) {
        return s;
    }
    SaveFile::default()
}

/// Replace the save, atomically, keeping the previous good copy.
pub fn store(app: &tauri::AppHandle, entries: serde_json::Map<String, serde_json::Value>) -> bool {
    let Some(d) = dir(app) else { return false };
    let file = d.join(FILE_NAME);
    let tmp = d.join("synx-save.json.tmp");

    let blob = SaveFile {
        version: 1,
        app: format!("SYNX {}", env!("CARGO_PKG_VERSION")),
        saved: now_iso(),
        entries,
    };
    let Ok(text) = serde_json::to_string_pretty(&blob) else { return false };

    if fs::write(&tmp, text.as_bytes()).is_err() {
        return false;
    }
    // keep the last good one; ignore the error, a missing backup is not fatal
    if file.exists() {
        let _ = fs::copy(&file, d.join(BACKUP_NAME));
    }
    fs::rename(&tmp, &file).is_ok()
}

/// An ISO-8601 timestamp without pulling in a date crate.
///
/// The save's own `saved` field is for a human reading the file, so seconds
/// resolution and UTC are enough; nothing in the game parses it back.
fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;

    // days since epoch -> civil date (Howard Hinnant's algorithm)
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, tod / 3600, (tod % 3600) / 60, tod % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamp_looks_like_a_date() {
        let s = now_iso();
        assert_eq!(s.len(), 20, "unexpected timestamp shape: {s}");
        assert!(s.ends_with('Z'));
        let year: i32 = s[..4].parse().expect("a four-digit year");
        assert!((2020..2200).contains(&year), "year {year} is not plausible");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }

    #[test]
    fn save_file_round_trips() {
        let mut e = serde_json::Map::new();
        e.insert("synx.story.v2".into(), serde_json::json!({ "chapter": 3 }));
        e.insert("synx.record.v1".into(), serde_json::json!(91.25));
        let blob = SaveFile { version: 1, app: "SYNX".into(), saved: now_iso(), entries: e };
        let text = serde_json::to_string_pretty(&blob).unwrap();
        // it has to be readable by a person, not just by serde
        assert!(text.contains("\"synx.story.v2\""));
        assert!(text.contains("\"chapter\": 3"), "values must be real JSON, not escaped strings");
        let back: SaveFile = serde_json::from_str(&text).unwrap();
        assert_eq!(back.entries["synx.record.v1"], serde_json::json!(91.25));
    }
}
