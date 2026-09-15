//! Where a recording goes, and how it gets there.
//!
//! The webview cannot write a file. It encodes the clip - see
//! `crates/synx-rec` - and hands the finished bytes over once; this is the
//! side that owns the disk.
//!
//! # The directory is DERIVED, never hard-coded
//!
//! A path written into the binary is a path that is wrong on somebody's
//! machine: a Windows user whose profile is on D:, a Mac whose home is on a
//! network volume, a Linux desktop that has moved `~/Videos` somewhere else in
//! `user-dirs.dirs`. Every platform already has an answer to "where does a
//! video go", and this asks it rather than guessing:
//!
//!   Windows   %USERPROFILE%\Videos\SYNX
//!   macOS     ~/Movies/SYNX
//!   Linux     $XDG_VIDEOS_DIR/SYNX, or ~/Videos/SYNX
//!
//! and on any of them, if the answer does not exist and cannot be created, it
//! falls back to the directory the save file already lives in - which is
//! somewhere the game has demonstrably been able to write, because the save is
//! there. A recorder that loses a clip because a folder was missing is worse
//! than one that puts it somewhere unexpected and says so.
//!
//! # The name
//!
//! `SYNX-2026-09-15-190412-CLEAN LANDING.avi`, with the label coming from the
//! highlight that was marked. Sortable, unique to the second, and it says what
//! is in it - which is the difference between a folder of clips and a folder
//! of `clip_0007`.

use std::path::{Path, PathBuf};

/// The first of these environment variables that names an existing directory.
fn env_dir(names: &[&str]) -> Option<PathBuf> {
    for n in names {
        if let Ok(v) = std::env::var(n) {
            if v.is_empty() {
                continue;
            }
            let p = PathBuf::from(v);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    None
}

fn home() -> Option<PathBuf> {
    env_dir(&["USERPROFILE", "HOME"])
}

/// Where the platform says videos go, before SYNX's own folder is added.
fn videos_root() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // The registry knows about a relocated Videos folder; the profile is
        // the answer for everyone who has not moved it.
        if let Some(h) = home() {
            let v = h.join("Videos");
            if v.is_dir() {
                return Some(v);
            }
            return Some(h);
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        home().map(|h| {
            let m = h.join("Movies");
            if m.is_dir() {
                m
            } else {
                h
            }
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        /* XDG first, and it is worth reading the file rather than only the
           variable: a desktop session exports XDG_VIDEOS_DIR, but a game
           launched from a terminal or a .desktop file often has nothing in the
           environment at all. */
        if let Some(v) = env_dir(&["XDG_VIDEOS_DIR"]) {
            return Some(v);
        }
        let h = home()?;
        let cfg = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| h.join(".config"));
        if let Ok(txt) = std::fs::read_to_string(cfg.join("user-dirs.dirs")) {
            for line in txt.lines() {
                let line = line.trim();
                if !line.starts_with("XDG_VIDEOS_DIR=") {
                    continue;
                }
                let raw = line["XDG_VIDEOS_DIR=".len()..].trim().trim_matches('"');
                let expanded = raw.replace("$HOME", &h.to_string_lossy());
                let p = PathBuf::from(expanded);
                if p.is_dir() {
                    return Some(p);
                }
            }
        }
        let v = h.join("Videos");
        if v.is_dir() {
            return Some(v);
        }
        Some(h)
    }
}

/// The directory clips are written to, created if it is not there.
///
/// `fallback` is the save directory, which the host already knows how to find
/// and has already written to.
pub fn dir(fallback: Option<&Path>) -> Option<PathBuf> {
    if let Some(root) = videos_root() {
        let d = root.join("SYNX");
        if std::fs::create_dir_all(&d).is_ok() {
            return Some(d);
        }
    }
    let f = fallback?.join("clips");
    std::fs::create_dir_all(&f).ok()?;
    Some(f)
}

/// Strip anything a filesystem would refuse, on any of the three platforms.
///
/// The label comes from the game's own highlight tags, so it is already tame -
/// but it is a string that reaches a path, and a string that reaches a path
/// gets checked. Windows is the strict one: it refuses `<>:"/\|?*`, control
/// characters, a trailing dot or space, and a handful of reserved names.
fn tame(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    for c in label.chars() {
        let ok = c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_');
        out.push(if ok { c } else { '-' });
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim().trim_matches('.').trim().to_string();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if out.is_empty() || RESERVED.iter().any(|r| r.eq_ignore_ascii_case(&out)) {
        return String::new();
    }
    out
}

/// `SYNX-<stamp>[-LABEL].avi`
pub fn file_name(label: &str, stamp: &str) -> String {
    let l = tame(label);
    if l.is_empty() {
        format!("SYNX-{stamp}.avi")
    } else {
        format!("SYNX-{stamp}-{l}.avi")
    }
}

/// Write one clip. Returns the full path it landed at.
pub fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    let path = dir.join(name);
    /* Written to a neighbour and renamed, the same way the save file is: a
       forty-megabyte write that is interrupted half way leaves a file that
       looks like a clip and is not one, and a player would find that out by
       opening it. A rename is atomic on all three platforms. */
    let tmp = dir.join(format!(".{name}.part"));
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, &path) {
        Ok(()) => Ok(path),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_cannot_escape_the_directory() {
        for bad in ["../../etc/passwd", "a/b", "a\\b", "C:hello", "..", "."] {
            let n = file_name(bad, "2026-01-01-000000");
            assert!(!n.contains('/'), "{n} still has a separator");
            assert!(!n.contains('\\'), "{n} still has a separator");
            assert!(!n.contains(':'), "{n} still has a colon");
            assert!(n.starts_with("SYNX-"), "{n} does not start with the prefix");
            assert!(n.ends_with(".avi"), "{n} is not an avi");
        }
    }

    #[test]
    fn a_reserved_windows_name_is_dropped() {
        assert_eq!(file_name("CON", "S"), "SYNX-S.avi");
        assert_eq!(file_name("nul", "S"), "SYNX-S.avi");
    }

    #[test]
    fn an_ordinary_label_survives_intact() {
        assert_eq!(file_name("CLEAN LANDING", "2026-09-15-190412"),
            "SYNX-2026-09-15-190412-CLEAN LANDING.avi");
        assert_eq!(file_name("R-IX PASS", "S"), "SYNX-S-R-IX PASS.avi");
    }

    #[test]
    fn a_long_label_is_cut_rather_than_refused() {
        let n = file_name(&"A".repeat(200), "S");
        assert!(n.len() < 80, "the name came to {} characters", n.len());
        assert!(n.starts_with("SYNX-S-A"));
    }

    #[test]
    fn a_control_character_does_not_reach_the_path() {
        let n = file_name("WIN\u{0}\u{1b}[31m", "S");
        assert!(!n.contains('\u{0}'));
        assert!(!n.contains('\u{1b}'));
    }
}
