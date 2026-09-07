//! The pre-launch window: what it can set, and how the game window is built
//! from the answer.
//!
//! # Why there is a launcher at all
//!
//! Three of the settings the game used to carry on its own options screen
//! cannot honestly be changed from inside a running game:
//!
//!   * **The renderer.** A webview's graphics backend is chosen when its
//!     environment is created and cannot be swapped underneath a live GPU
//!     context. The old row said "takes effect on restart", which is a setting
//!     that does not work wearing a label that admits it.
//!   * **The window mode and size.** Changing these while a 3D context is live
//!     reallocates every render target the frame is holding, mid-frame.
//!   * **The display.** A monitor cannot be chosen after the window is on one.
//!
//! So they moved to the one place where they are free: before the window
//! exists. That is what this module is - the model behind the launcher screen,
//! and the builder that turns its answer into the game window.
//!
//! # What it deliberately does NOT own
//!
//! Everything that CAN be changed live stays on the in-game options screen.
//! A launcher that owns the audio volume is a launcher the player has to quit
//! the game to use, and the two screens then disagree about which is
//! authoritative. The split is not "settings vs settings", it is "things that
//! need a fresh window" against "things that do not".
//!
//! # Persistence
//!
//! These live in the same save file as everything else, under their own key,
//! so there is one file to back up and one format to migrate. The launcher
//! writes them before it builds the window; the game reads the ones it also
//! cares about (the render scale) through the ordinary settings path.

use serde::{Deserialize, Serialize};

use crate::platform::Renderer;

/// The key the launcher's own settings live under in the save file.
pub const KEY: &str = "synx.launcher.v1";

/// How the game window sits on the desktop.
///
/// There is no "exclusive fullscreen" here on purpose. A webview cannot take
/// an exclusive display mode - it has no swapchain of its own to hand to the
/// compositor - so offering one would be a label for something that does not
/// happen. Borderless over the whole monitor is what it can actually do, and
/// on a modern compositor it is what exclusive fullscreen mostly gets you
/// anyway, without the mode switch or the alt-tab cost.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowMode {
    /// A normal resizable window at the chosen size.
    Windowed,
    /// No decorations, filling the chosen monitor.
    Borderless,
    /// Tauri's fullscreen. On Windows this is also borderless-over-the-monitor;
    /// it is kept separate because it goes through the platform's own path and
    /// some compositors treat it differently.
    Fullscreen,
}

impl Default for WindowMode {
    fn default() -> Self {
        WindowMode::Borderless
    }
}

/// Everything the launcher decides.
///
/// Every field has a default that is correct on a machine that has never run
/// the game, because the first launch reads this before the player has ever
/// seen the screen.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct LauncherSettings {
    pub mode: WindowMode,
    /// Window size in logical pixels, used only by `WindowMode::Windowed`.
    pub width: f64,
    pub height: f64,
    /// Which monitor, as an index into the list the launcher was shown. Out of
    /// range means "the primary one", so unplugging a screen between sessions
    /// cannot open the window on a display that is not there.
    pub monitor: usize,
    /// `false` selects the software rasteriser. See [`Renderer`].
    pub gpu: bool,
    /// Keep the window on top of everything else. Off by default: it is a
    /// preference, and a game that silently sits above the player's other
    /// windows is a nuisance.
    pub always_on_top: bool,
    /* THE FRAME LIMIT IS NOT HERE ANY MORE.

       It was: a `fps_cap` field, defaulted, clamped in `sanitised`, and
       covered by a round-trip test. Every one of those was true and none of
       them mattered, because nothing ever read the value - not this crate, and
       not the game, which cannot see this entry at all. A cap is enforced by
       whatever draws the frames, so the row moved to the ordinary settings the
       renderer already loads. See the note on it in js/settings.js.

       An older save still carries the field; serde ignores what it does not
       know, so it is simply left behind. */
    /// Ask the compositor not to tear.
    ///
    /// Applied on the webview's command line by `platform::browser_args`,
    /// which means it is fixed when the environment is created - so changing
    /// it relaunches the process, exactly as the renderer does.
    pub vsync: bool,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        LauncherSettings {
            mode: WindowMode::default(),
            width: 1600.0,
            height: 900.0,
            monitor: 0,
            gpu: true,
            always_on_top: false,
            vsync: true,
        }
    }
}

impl LauncherSettings {
    /// The renderer this asks for.
    pub fn renderer(&self) -> Renderer {
        if self.gpu {
            Renderer::Gpu
        } else {
            Renderer::Cpu
        }
    }

    /// Clamp anything a hand-edited save could get wrong.
    ///
    /// The save file is deliberately human-readable and human-editable, which
    /// means it is also human-breakable. A width of zero, of NaN, or of four
    /// hundred thousand must not reach the window builder - a window that is
    /// created off-screen or at a size the compositor refuses is a game that
    /// starts and cannot be seen, with no way back to the launcher that did it.
    pub fn sanitised(mut self) -> Self {
        if !self.width.is_finite() || !self.height.is_finite() {
            self.width = 1600.0;
            self.height = 900.0;
        }
        self.width = self.width.clamp(MIN_W, 16384.0);
        self.height = self.height.clamp(MIN_H, 16384.0);
        self
    }
}

/// The smallest window the interface still lays out in. The options screen and
/// the mode terminal are both built against this, so going below it is not a
/// small window, it is a broken one.
pub const MIN_W: f64 = 960.0;
pub const MIN_H: f64 = 540.0;

/// Read the launcher's settings out of the save file.
///
/// Tolerant in exactly the way [`crate::platform::preferred_renderer`] is: a
/// missing file, a corrupt file, a save written by a build that predates this
/// screen, or a field of the wrong type all mean "the defaults". The one thing
/// that must never happen is a startup that fails because a preference could
/// not be parsed.
pub fn load(dir: Option<&std::path::Path>) -> LauncherSettings {
    let fallback = LauncherSettings::default();
    let Some(dir) = dir else { return fallback };
    let Ok(text) = std::fs::read_to_string(dir.join(crate::save::FILE_NAME)) else {
        return fallback;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return fallback;
    };
    let entry = v.get("entries").and_then(|e| e.get(KEY));
    let parsed = match entry {
        // the shape this build writes
        Some(serde_json::Value::Object(_)) => {
            serde_json::from_value::<LauncherSettings>(entry.cloned().unwrap()).ok()
        }
        // ...or a JSON document inside a JSON string, which is what the
        // browser build's localStorage bridge produces
        Some(serde_json::Value::String(s)) => serde_json::from_str::<LauncherSettings>(s).ok(),
        _ => None,
    };
    match parsed {
        Some(p) => p.sanitised(),
        // NOTHING UNDER OUR KEY. This is either a first run or a save written
        // before the launcher existed, and the two want different answers: a
        // player who had already chosen the software renderer and a windowed
        // game must not silently get a borderless hardware one back because
        // the setting moved screens. So the old rows are read across.
        None => migrate_from_settings(&v).sanitised(),
    }
}

/// Carry the pre-launcher rows over the first time this build runs.
///
/// `synx.settings.v1` used to carry `display` (0 windowed, 1 fullscreen) and
/// `renderer` (0 GPU, 1 CPU) alongside the graphics rows. Those three moved to
/// the launcher; everything else on that key stays exactly where it was and is
/// still read by the game.
fn migrate_from_settings(v: &serde_json::Value) -> LauncherSettings {
    let mut out = LauncherSettings::default();
    let entry = v.get("entries").and_then(|e| e.get("synx.settings.v1"));
    let obj = match entry {
        Some(serde_json::Value::Object(m)) => Some(m.clone()),
        Some(serde_json::Value::String(s)) => serde_json::from_str::<serde_json::Value>(s)
            .ok()
            .and_then(|o| o.as_object().cloned()),
        _ => None,
    };
    let Some(obj) = obj else { return out };
    if let Some(1) = obj.get("renderer").and_then(|r| r.as_i64()) {
        out.gpu = false;
    }
    out.mode = match obj.get("display").and_then(|d| d.as_i64()) {
        Some(0) => WindowMode::Windowed,
        // 1 was FULLSCREEN, which this build calls borderless - see WindowMode
        _ => WindowMode::Borderless,
    };
    out
}

/// One entry in the launcher's DISPLAY list.
#[derive(Serialize)]
pub struct MonitorInfo {
    pub name: String,
    /// Where this display's top-left corner sits on the virtual desktop, in
    /// physical pixels.
    ///
    /// Reported because a size on its own cannot answer the only question
    /// that matters about a multi-monitor setting: WHICH SCREEN did the window
    /// actually open on. Two 1920x1080 displays are indistinguishable by size,
    /// and the launcher had no way to tell them apart or to say where they
    /// were - so nothing in the tree, and no test, could check that choosing
    /// one had any effect. tools/checkdisplay.js needs exactly this.
    pub x: i32,
    pub y: i32,
    /// Physical pixels.
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// The common 16:9 ladder, before it is filtered against a display.
pub const COMMON_SIZES: &[(u32, u32)] = &[
    (1280, 720),
    (1366, 768),
    (1600, 900),
    (1920, 1080),
    (2560, 1440),
    (3200, 1800),
    (3840, 2160),
];

/// The window sizes offered for `Windowed` on a given display.
///
/// Filtered against that display rather than listed blind: offering 2560x1440
/// on a 1080p laptop is offering a window whose bottom edge the player cannot
/// reach. Everything is dropped that would not fit with room for the title bar
/// and the taskbar, and the list is never empty - a display too small for any
/// rung still has to offer the minimum the interface lays out in.
pub fn sizes_for(mon: &MonitorInfo) -> Vec<[u32; 2]> {
    let scale = if mon.scale > 0.1 { mon.scale } else { 1.0 };
    // Logical pixels, which is what the window builder takes.
    let max_w = (mon.width as f64 / scale) * 0.98;
    let max_h = (mon.height as f64 / scale) * 0.92;
    let mut out: Vec<[u32; 2]> = COMMON_SIZES
        .iter()
        .filter(|(w, h)| {
            f64::from(*w) <= max_w
                && f64::from(*h) <= max_h
                && f64::from(*w) >= MIN_W
                && f64::from(*h) >= MIN_H
        })
        .map(|(w, h)| [*w, *h])
        .collect();
    if out.is_empty() {
        out.push([MIN_W as u32, MIN_H as u32]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &std::path::Path, v: serde_json::Value) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(crate::save::FILE_NAME),
            serde_json::to_string_pretty(&v).unwrap(),
        )
        .unwrap();
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Nothing on disk, nowhere to look, and outright rubbish all have to mean
    /// "the defaults". A launcher that refuses to open because a preference
    /// file is malformed is a game that cannot be started at all.
    #[test]
    fn a_broken_save_still_launches() {
        assert!(load(None).gpu);
        let d = tmp("synx-launcher-broken");
        assert!(load(Some(&d)).gpu); // no file
        std::fs::write(d.join(crate::save::FILE_NAME), b"{ not json").unwrap();
        assert!(load(Some(&d)).gpu);
        write(&d, serde_json::json!({ "entries": { KEY: 42 } }));
        assert!(load(Some(&d)).gpu);
        write(&d, serde_json::json!({ "entries": { KEY: { "mode": "sideways" } } }));
        assert!(load(Some(&d)).gpu);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let d = tmp("synx-launcher-roundtrip");
        let mut s = LauncherSettings::default();
        s.mode = WindowMode::Windowed;
        s.width = 1280.0;
        s.height = 720.0;
        s.gpu = false;
        s.monitor = 1;
        s.vsync = false;
        write(&d, serde_json::json!({ "entries": { KEY: serde_json::to_value(&s).unwrap() } }));

        let got = load(Some(&d));
        assert_eq!(got.mode, WindowMode::Windowed);
        assert_eq!(got.width, 1280.0);
        assert_eq!(got.monitor, 1);
        assert!(!got.vsync, "vertical sync did not survive the save file");
        assert_eq!(got.renderer(), Renderer::Cpu);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The save file is human-readable on purpose, so it is human-breakable.
    /// A window built at any of these sizes is a window the player cannot see
    /// or cannot get back from.
    #[test]
    fn a_hand_edited_size_cannot_produce_an_unusable_window() {
        let d = tmp("synx-launcher-sanitise");
        for (w, h) in [(0.0, 0.0), (-4000.0, 12.0), (999999.0, 999999.0)] {
            write(&d, serde_json::json!({
                "entries": { KEY: { "mode": "windowed", "width": w, "height": h } }
            }));
            let got = load(Some(&d));
            assert!(got.width >= MIN_W && got.width <= 16384.0, "width {}", got.width);
            assert!(got.height >= MIN_H && got.height <= 16384.0, "height {}", got.height);
        }
        // NaN arrives through JSON as null, which serde(default)s to the
        // default - but a value that becomes NaN in transit must still not pass
        let s = LauncherSettings { width: f64::NAN, height: f64::NAN, ..Default::default() }
            .sanitised();
        assert!(s.width.is_finite() && s.height.is_finite());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A player who had already chosen the software renderer and a windowed
    /// game must not silently get a hardware borderless one back because the
    /// settings moved from the options screen to the launcher.
    #[test]
    fn the_old_options_rows_are_carried_across() {
        let d = tmp("synx-launcher-migrate");

        write(&d, serde_json::json!({
            "entries": { "synx.settings.v1": { "renderer": 1, "display": 0, "quality": 2 } }
        }));
        let got = load(Some(&d));
        assert_eq!(got.renderer(), Renderer::Cpu, "the software renderer was dropped");
        assert_eq!(got.mode, WindowMode::Windowed, "windowed was dropped");

        // ...and the escaped-string shape an older save has
        write(&d, serde_json::json!({
            "entries": { "synx.settings.v1": "{\"renderer\":1,\"display\":1}" }
        }));
        let got = load(Some(&d));
        assert_eq!(got.renderer(), Renderer::Cpu);
        assert_eq!(got.mode, WindowMode::Borderless);

        // A save with neither key is a first run, not a migration.
        write(&d, serde_json::json!({ "entries": { "synx.record.v1": 91.2 } }));
        let got = load(Some(&d));
        assert_eq!(got.renderer(), Renderer::Gpu);

        // ...and the launcher's own key always wins over the old rows.
        write(&d, serde_json::json!({
            "entries": {
                "synx.settings.v1": { "renderer": 1, "display": 0 },
                KEY: { "gpu": true, "mode": "fullscreen" }
            }
        }));
        let got = load(Some(&d));
        assert_eq!(got.renderer(), Renderer::Gpu);
        assert_eq!(got.mode, WindowMode::Fullscreen);
        let _ = std::fs::remove_dir_all(&d);
    }
}
