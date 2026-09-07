// A desktop game, not a page in a window.
#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

//! SYNX desktop host.
//!
//! The browser build needed an HTTP server because `fetch` refuses `file://`
//! and `localStorage` has no origin there - so the game could not read
//! `data/scene.bin`, could not read its own save, and could not be
//! double-clicked. This host removes all three problems at once: every asset
//! is compiled into the executable and served over Tauri's own protocol, which
//! is a real origin, so `fetch` works, `localStorage` works, and the whole
//! thing is one file with nothing to install and nothing to start first.
//!
//! # ONE WINDOW, TWO PAGES
//!
//! The launcher and the game are the same window. It opens on `launcher.html`,
//! and PLAY reshapes that window to the chosen mode and navigates it to
//! `index.html`.
//!
//! This is not a stylistic preference; the first version created a second
//! window from inside the `launch_game` command and it did not work reliably.
//! A Tauri command runs on a worker thread, window creation has to reach the
//! platform's event loop, and building a window from off the main thread is
//! the kind of thing that works on one machine and silently does nothing on
//! the next. Reshaping a window that already exists needs no such trip, and
//! what little of it does - the resize - is explicitly marshalled through
//! `run_on_main_thread`.
//!
//! It is also simply fewer moving parts. There is no hidden second window to
//! reveal, no ordering problem between closing one and showing the other, and
//! no window left holding a GPU context after the player has moved on.
//!
//! What the native side owns:
//!
//!   * the window: its shape, its mode, which monitor it is on, and its first
//!     paint
//!   * `quit`, which is a real process exit rather than a tab that closes
//!   * the save file - a real, readable file next to the player's other game
//!     data, written atomically, rather than a WebView2 cache entry
//!   * a hardware report the game grades itself against on first run
//!
//! The one thing that genuinely cannot be re-decided at run time is the
//! renderer, because WebView2 caches one environment per process and the first
//! window created fixes it. So the window is built with the SAVED renderer's
//! arguments, and changing that row relaunches the process - see `launch_game`.
//! It is the only setting on that screen that costs a restart, and it is the
//! only one that says so.

mod diag;
mod launcher;
mod platform;
mod save;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};

/// Set once something has said the page is ready to be seen. Until then the
/// window stays hidden, so the player never sees an unstyled page or a white
/// flash before the launcher - the single most common way a webview-hosted
/// game gives itself away.
static SHOWN: AtomicBool = AtomicBool::new(false);

/// True when this process was started to go straight into the game, skipping
/// the launcher. Set by `--play`, which is what the process relaunches itself
/// with after a renderer change.
static SKIP_LAUNCHER: AtomicBool = AtomicBool::new(false);

/// The only window there is.
const MAIN: &str = "main";

const LAUNCHER_TITLE: &str = "SYNX";
const GAME_TITLE: &str = "SYNX — Synthwave eXtreme Racing";

/// The launcher's own shape. Small, fixed and centred: it is a dialogue, not a
/// document, and a resizable one invites being made a shape its layout was
/// never drawn for.
const LAUNCHER_W: f64 = 1100.0;
const LAUNCHER_H: f64 = 720.0;

#[derive(Serialize)]
struct HostInfo {
    platform: &'static str,
    arch: &'static str,
    /// Logical cores. The quality auto-grade uses it as a weak proxy for how
    /// much headroom the simulation has beside the renderer.
    cores: usize,
    version: &'static str,
    /// True when the save directory is writable, so the front end knows
    /// whether the save is durable.
    persistent: bool,
    /// The graphics path actually in use, as a sentence - for the launcher,
    /// and for a bug report.
    graphics: &'static str,
    /// Whether the running window is on the software rasteriser, which the
    /// front end shows so a slow machine is explained rather than mysterious.
    software: bool,
    /// Where the save actually is, so the game can tell the player.
    save_path: String,
}

// ------------------------------------------------------------- commands ----

/// Leave the game. This ends the process rather than merely closing a window -
/// there is no tab to go back to, and a hidden window still holding a GPU
/// context is the thing that makes a "quit" feel like it did not work.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    // Hide first so the webview tears its GPU resources down in order; `exit`
    // on its own can leave WebView2's compositor thread mid-frame.
    for (_, w) in app.webview_windows() {
        let _ = w.hide();
    }
    app.exit(0);
}

#[tauri::command]
fn host_info(app: tauri::AppHandle) -> HostInfo {
    HostInfo {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4),
        version: env!("CARGO_PKG_VERSION"),
        persistent: save::dir(&app).is_some(),
        graphics: platform::describe(startup_renderer()),
        software: startup_renderer() == platform::Renderer::Cpu,
        save_path: save::path(&app)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Reveal the window. Called by the launcher once it has drawn itself, and by
/// the game once its first frame has landed.
///
/// Deliberately not keyed on which page is asking: it is one window, both
/// pages want the same thing from it, and showing an already-visible window is
/// a no-op everywhere.
#[tauri::command]
fn ready(window: WebviewWindow) {
    SHOWN.store(true, Ordering::SeqCst);
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> bool {
    let _ = window.set_fullscreen(on);
    window.is_fullscreen().unwrap_or(on)
}

#[tauri::command]
fn is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

// ------------------------------------------------------------- launcher ----

/// What the launcher screen needs to draw itself.
#[derive(Serialize)]
struct LauncherView {
    settings: launcher::LauncherSettings,
    monitors: Vec<launcher::MonitorInfo>,
    /// Sizes offered for WINDOWED, already filtered against the chosen
    /// monitor - see `launcher::COMMON_SIZES`.
    sizes: Vec<[u32; 2]>,
    /// The renderer the PROCESS started with. The launcher compares its own
    /// selection against this to know whether PLAY needs a relaunch.
    started_gpu: bool,
    graphics: &'static str,
    version: &'static str,
    platform: &'static str,
}

#[tauri::command]
fn launcher_view(app: tauri::AppHandle, window: WebviewWindow) -> LauncherView {
    let settings = launcher::load(save::dir(&app).as_deref());
    let mut monitors: Vec<launcher::MonitorInfo> = Vec::new();

    let primary_name = window.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    if let Ok(list) = window.available_monitors() {
        for m in list {
            let size = m.size();
            let name = m.name().cloned().unwrap_or_else(|| "DISPLAY".into());
            monitors.push(launcher::MonitorInfo {
                primary: Some(&name) == primary_name.as_ref(),
                name,
                width: size.width,
                height: size.height,
                scale: m.scale_factor(),
            });
        }
    }
    if monitors.is_empty() {
        monitors.push(launcher::MonitorInfo {
            name: "DISPLAY".into(),
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: true,
        });
    }

    let idx = settings.monitor.min(monitors.len() - 1);
    let sizes = launcher::sizes_for(&monitors[idx]);

    LauncherView {
        settings,
        monitors,
        sizes,
        started_gpu: startup_renderer() == platform::Renderer::Gpu,
        graphics: platform::describe(startup_renderer()),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

/// Persist the launcher's answers into the save file, under its own key.
///
/// Kept separate from `save_store` so the launcher does not have to read,
/// merge and rewrite the whole save just to change a window size.
// ---------------------------------------------------------- diagnostics ----

/// Where the save (and therefore any report) lives, without needing an App.
fn diag_dir() -> Option<std::path::PathBuf> {
    dirs_app_data()
}

/// Gather the machine description. Monitors need a window to ask through, so
/// they are passed in rather than looked up here.
fn system_report(window: Option<&WebviewWindow>) -> diag::SystemReport {
    let mut monitors = Vec::new();
    if let Some(w) = window {
        if let Ok(list) = w.available_monitors() {
            for m in list {
                let s = m.size();
                monitors.push(format!(
                    "{}x{} at {:.2}x scale ({})",
                    s.width,
                    s.height,
                    m.scale_factor(),
                    m.name().cloned().unwrap_or_else(|| "unnamed".into())
                ));
            }
        }
    }
    diag::system(
        platform::describe(startup_renderer()),
        diag_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        monitors,
    )
}

/// The front end adds a line to the in-memory trace. Nothing is written.
#[tauri::command]
fn diag_note(line: String) {
    // bounded, because this is reachable from a page
    let mut s = line;
    s.truncate(400);
    diag::note(format!("page: {s}"));
}

/// The machine, for the launcher's own diagnostics panel.
#[tauri::command]
fn diag_system(window: WebviewWindow) -> diag::SystemReport {
    system_report(Some(&window))
}

/// Something went wrong: write the report and say where it went.
///
/// This is the ONLY thing that creates a log file from the front end, which is
/// what keeps a successful run from leaving one behind.
#[tauri::command]
fn diag_report(
    window: WebviewWindow,
    reason: String,
    details: Option<serde_json::Value>,
) -> Option<String> {
    diag::note(format!("report requested: {reason}"));
    let sys = system_report(Some(&window));
    diag::write_report(diag_dir().as_deref(), &reason, &sys, details.as_ref())
}

/// Was there a report from a previous run, and where is it?
///
/// The launcher asks once, on the way up. A crash that took the process down
/// with it cannot write anything itself - see the breadcrumb note in diag.rs -
/// so this is how the player finds out it happened at all.
#[tauri::command]
fn diag_previous() -> Option<String> {
    let dir = diag_dir()?;
    let p = dir.join(diag::REPORT_NAME);
    if p.exists() {
        Some(p.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Throw the last report away. The launcher offers this once the player has
/// read it, so the panel does not nag about a problem they have dealt with.
#[tauri::command]
fn diag_clear() -> bool {
    let Some(dir) = diag_dir() else { return false };
    std::fs::remove_file(dir.join(diag::REPORT_NAME)).is_ok()
}

/// Open the report in whatever the desktop uses for a text file.
#[tauri::command]
fn diag_open() -> bool {
    let Some(dir) = diag_dir() else { return false };
    let p = dir.join(diag::REPORT_NAME);
    if !p.exists() {
        return false;
    }
    /* No shell plugin, and no shell. Each platform's own opener is invoked
       directly with the path as an argument, so nothing is ever interpreted as
       a command - the path is data, and a folder name with a space or an
       ampersand in it cannot become anything else. */
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler"])
        .arg(&p)
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(&p).spawn();
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open").arg(&p).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let r: std::io::Result<std::process::Child> =
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no opener"));
    r.is_ok()
}

#[tauri::command]
fn launcher_store(app: tauri::AppHandle, settings: serde_json::Value) -> bool {
    let mut file = save::load(&app);
    file.entries.insert(launcher::KEY.to_string(), settings);
    save::store(&app, file.entries)
}

/// Reshape the window for the chosen mode and take it to the game.
///
/// Returns a message rather than panicking: a PLAY button that does nothing is
/// the worst possible outcome here, so every failure has to be reportable back
/// to the screen that asked.
#[tauri::command]
fn launch_game(app: tauri::AppHandle, settings: serde_json::Value) -> Result<bool, String> {
    let parsed: launcher::LauncherSettings = serde_json::from_value(settings.clone())
        .map_err(|e| format!("settings were not understood: {e}"))?;
    let parsed = parsed.sanitised();
    // Persist first. If the relaunch below happens, this is what the new
    // process reads on its way up.
    launcher_store(app.clone(), settings);

    /* THE ONE SETTING THAT COSTS A RESTART.

       WebView2 caches a single environment per process and the first window
       created is what fixes its command line, so the renderer cannot be
       changed underneath a webview that already exists. Rather than have the
       row quietly not work - which is what "takes effect on restart" amounted
       to - the process relaunches itself with `--play`, so the player gets
       what they asked for immediately and lands in the game rather than back
       on this screen. */
    if parsed.renderer() != startup_renderer() {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find the executable: {e}"))?;
        std::process::Command::new(exe)
            .arg("--play")
            .spawn()
            .map_err(|e| format!("could not restart for the renderer change: {e}"))?;
        app.exit(0);
        return Ok(true);
    }

    let window = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "the window has gone".to_string())?;

    /* The address of the game page, derived from the address of this one.

       Resolved by joining rather than by being written out, because the origin
       a Tauri asset is served from is not the same string on every platform -
       `tauri://localhost` on Windows, `http://tauri.localhost` elsewhere - and
       a hard-coded one is a launcher that works on the machine it was written
       on. Joining "index.html" against the current URL is correct on all of
       them because it never has to know what the origin is. */
    let here = window.url().map_err(|e| format!("cannot read the current address: {e}"))?;
    let target = here
        .join("index.html")
        .map_err(|e| format!("cannot resolve the game page: {e}"))?;

    apply_window(&app, &window, &parsed);

    window
        .navigate(target)
        .map_err(|e| format!("could not open the game: {e}"))?;
    Ok(true)
}

/// Put the window into the shape the launcher asked for.
///
/// Everything here is best-effort on purpose. A compositor that refuses to
/// remove a window's decorations, or a monitor that has been unplugged since
/// the setting was saved, must leave the player with a window they can still
/// use - not with a failed launch.
///
/// # What differs between platforms
///
/// On Windows and on X11 all of this does what it says. On **Wayland** a
/// client is not permitted to position its own window, so `set_position` is a
/// no-op there: BORDERLESS still becomes an undecorated window of the right
/// size, and the compositor decides which output it lands on. That is a
/// limitation of the protocol rather than something to work around, and
/// FULLSCREEN - which goes through the compositor's own path - is the setting
/// to use on a multi-monitor Wayland desktop. Nothing here fails because of
/// it; the window is simply where the compositor put it.
fn apply_window(app: &tauri::AppHandle, window: &WebviewWindow, s: &launcher::LauncherSettings) {
    let _ = window.set_title(GAME_TITLE);
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(launcher::MIN_W, launcher::MIN_H)));
    let _ = window.set_always_on_top(s.always_on_top);

    // Leaving fullscreen first: a window that is already fullscreen ignores
    // every size and position change made while it still is.
    let _ = window.set_fullscreen(false);

    match s.mode {
        launcher::WindowMode::Windowed => {
            let _ = window.set_decorations(true);
            let _ = window.set_resizable(true);
            resize_on_main(app, window, Target::Windowed(s.width, s.height, s.monitor));
        }
        launcher::WindowMode::Borderless => {
            /* Decorations off and sized to the whole monitor. `maximize` is
               not the same thing: it stops at the work area, so the taskbar
               stays in front of a game that asked for the whole screen. */
            let _ = window.set_decorations(false);
            let _ = window.set_resizable(false);
            resize_on_main(app, window, Target::Borderless(s.monitor));
        }
        launcher::WindowMode::Fullscreen => {
            let _ = window.set_decorations(true);
            let _ = window.set_resizable(true);
            let _ = window.set_fullscreen(true);
        }
    }
}

/// Shrink the launcher if it does not fit the screen it opened on.
///
/// 1100x720 is comfortable on almost everything and too tall on the one thing
/// that is still very common: a 1366x768 laptop, where it would open with its
/// footer - and therefore its PLAY button - under the taskbar. A launcher you
/// cannot press PLAY on is worse than an ugly one.
///
/// The monitor is only addressable once the window exists, which is why this
/// runs after the build rather than choosing a size before it.
fn fit_launcher(window: &WebviewWindow) {
    let Ok(Some(mon)) = window.current_monitor() else { return };
    let scale = mon.scale_factor();
    if scale <= 0.0 {
        return;
    }
    let size = mon.size();
    // logical pixels, which is what the window was asked for in
    let avail_w = f64::from(size.width) / scale;
    let avail_h = f64::from(size.height) / scale;
    // leave room for a taskbar and a title bar rather than filling exactly
    let w = LAUNCHER_W.min(avail_w * 0.94).max(880.0);
    let h = LAUNCHER_H.min(avail_h * 0.88).max(560.0);
    if (w - LAUNCHER_W).abs() < 1.0 && (h - LAUNCHER_H).abs() < 1.0 {
        return;
    }
    /* The minimum has to come down FIRST. It was set to the launcher's own
       size so a compositor that ignores `resizable(false)` cannot squash the
       layout - which also means the window refuses to shrink below it until
       the minimum itself moves. */
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(w, h)));
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    let _ = window.center();
}

enum Target {
    /// width, height, monitor index
    Windowed(f64, f64, usize),
    /// monitor index
    Borderless(usize),
}

/// Move and size the window, on the platform's own thread.
///
/// A Tauri command runs on a worker thread. Most window calls are dispatched
/// safely from there, but a resize followed immediately by a reposition is the
/// pair most likely to be applied out of order or dropped - so the whole
/// sequence is marshalled onto the main thread and applied in one go.
fn resize_on_main(app: &tauri::AppHandle, window: &WebviewWindow, t: Target) {
    let w = window.clone();
    let run = move || {
        let monitors = w.available_monitors().unwrap_or_default();
        match t {
            Target::Borderless(idx) => {
                let mon = monitors.get(idx).or_else(|| monitors.first());
                if let Some(mon) = mon {
                    let pos = *mon.position();
                    let size = *mon.size();
                    // Position first, then size: sizing first can push the
                    // window back onto the primary display on a mixed-DPI
                    // desktop, and it then fills the wrong screen.
                    let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                    let _ = w.set_size(tauri::PhysicalSize::new(size.width, size.height));
                } else {
                    let _ = w.maximize();
                }
            }
            Target::Windowed(width, height, idx) => {
                let _ = w.set_size(tauri::LogicalSize::new(width, height));
                let mon = monitors.get(idx);
                match mon {
                    Some(mon) => {
                        // centre on the CHOSEN monitor rather than the primary
                        let pos = *mon.position();
                        let size = *mon.size();
                        let scale = mon.scale_factor();
                        let pw = (width * scale) as i32;
                        let ph = (height * scale) as i32;
                        let x = pos.x + (size.width as i32 - pw).max(0) / 2;
                        let y = pos.y + (size.height as i32 - ph).max(0) / 2;
                        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                    }
                    None => {
                        let _ = w.center();
                    }
                }
            }
        }
        let _ = w.set_focus();
    };
    // If the main thread cannot be reached, do it here rather than not at all.
    if app.run_on_main_thread(run).is_err() {
        // `run` was moved; rebuild the only part that matters as a fallback.
        let _ = window.center();
    }
}

// ----------------------------------------------------------------- save ----

/// Read the save. One file rather than a key per file: the game writes several
/// keys together at the end of a chapter, and a partial set on disk is worse
/// than none.
#[tauri::command]
fn save_load(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::Value::Object(save::load(&app).entries)
}

/// Replace the save. Atomic, and it keeps the previous good copy - `save.rs`
/// explains why both of those matter.
#[tauri::command]
fn save_store(app: tauri::AppHandle, data: serde_json::Value) -> bool {
    match data {
        serde_json::Value::Object(m) => save::store(&app, m),
        _ => false,
    }
}

/// Erase the save. The game confirms before calling this, and the `.bak` is
/// deliberately left alone so an accidental erase is still recoverable by hand.
#[tauri::command]
fn save_clear(app: tauri::AppHandle) -> bool {
    match save::path(&app) {
        Some(p) => std::fs::remove_file(p).is_ok(),
        None => false,
    }
}

/// The renderer the process actually started with.
static STARTUP_RENDERER: std::sync::OnceLock<platform::Renderer> = std::sync::OnceLock::new();

fn startup_renderer() -> platform::Renderer {
    *STARTUP_RENDERER.get().unwrap_or(&platform::Renderer::Gpu)
}

fn main() {
    /* Before anything else.

       The graphics backend and, on Linux, the compositing mode are read by the
       webview when it is created, so the preference has to be known and
       applied first. `app_data_dir` is not available until there is an App, so
       the directory is resolved by hand here - the same path Tauri will use. */
    let dir = dirs_app_data();
    let saved = launcher::load(dir.as_deref());
    let renderer = saved.renderer();
    let _ = STARTUP_RENDERER.set(renderer);
    platform::apply_env(renderer);

    let skip = std::env::args().any(|a| a == "--play");
    SKIP_LAUNCHER.store(skip, Ordering::SeqCst);

    diag::note(format!(
        "start: SYNX {} on {} {}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    diag::note(format!("renderer: {}", platform::describe(renderer)));
    diag::note(format!("skip launcher: {skip}"));

    /* DID THE LAST RUN SURVIVE?

       A graphics driver that takes the process down leaves no panic to hook
       and no chance to write anything. The only evidence is the breadcrumb the
       dying run left behind - see diag.rs - so it is read here, before the
       thing that killed it is attempted again. */
    if let Some(step) = diag::take_breadcrumb(dir.as_deref()) {
        diag::note(format!("the previous run did not survive: {step}"));
        let sys = diag::system(
            platform::describe(renderer),
            dir.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
            Vec::new(),
        );
        let _ = diag::write_report(
            dir.as_deref(),
            &format!(
                "The previous launch stopped without warning while: {step}. \n                 That is almost always the graphics driver - try RENDERER = SOFTWARE."
            ),
            &sys,
            None,
        );
    }

    /* ...and a panic here, which IS catchable, writes the same report rather
       than printing to a console no player is looking at. */
    {
        let dir2 = dir.clone();
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            diag::note(format!("panic: {info}"));
            let sys = diag::system(
                platform::describe(renderer),
                dir2.as_ref().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                Vec::new(),
            );
            let _ = diag::write_report(
                dir2.as_deref(),
                &format!("The host stopped with an internal error: {info}"),
                &sys,
                None,
            );
            prev(info);
        }));
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            quit_app,
            host_info,
            ready,
            set_fullscreen,
            is_fullscreen,
            launcher_view,
            launcher_store,
            launch_game,
            diag_note,
            diag_system,
            diag_report,
            diag_previous,
            diag_clear,
            diag_open,
            save_load,
            save_store,
            save_clear,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let dir2 = dir.clone();
            println!("SYNX graphics: {}", platform::describe(renderer));

            let start_at_game = SKIP_LAUNCHER.load(Ordering::SeqCst);
            let url = if start_at_game { "index.html" } else { "launcher.html" };

            #[allow(unused_mut)]
            let mut b = tauri::WebviewWindowBuilder::new(
                &handle,
                MAIN,
                tauri::WebviewUrl::App(url.into()),
            )
            .title(if start_at_game { GAME_TITLE } else { LAUNCHER_TITLE })
            .theme(Some(tauri::Theme::Dark))
            // hidden until the page says it has drawn - see `ready`
            .visible(false)
            .disable_drag_drop_handler();

            if start_at_game {
                b = b
                    .inner_size(saved.width, saved.height)
                    .min_inner_size(launcher::MIN_W, launcher::MIN_H)
                    .resizable(true)
                    .center();
            } else {
                /* The launcher's shape. `min_inner_size` is set to the same
                   thing so a compositor that ignores `resizable(false)` - some
                   tiling window managers do - still cannot squash the layout
                   below what it was drawn for. */
                b = b
                    .inner_size(LAUNCHER_W, LAUNCHER_H)
                    .min_inner_size(LAUNCHER_W, LAUNCHER_H)
                    .resizable(false)
                    .center();
            }

            #[cfg(target_os = "windows")]
            {
                b = b.additional_browser_args(&platform::browser_args(renderer));
            }

            /* BUILDING THE WEBVIEW IS THE RISKY STEP.

               This is where a broken graphics driver takes the process down,
               and it is the single most common way this game fails to start on
               a machine it has never run on. The breadcrumb is what lets the
               NEXT run say so. */
            diag::begin_step(dir2.as_deref(), "creating the game window and its webview");
            let window = b.build()?;
            diag::end_step(dir2.as_deref(), "creating the game window and its webview");

            // The game window's shape is applied after the build, because the
            // monitor is only addressable once there is a window to ask
            // through.
            if start_at_game {
                apply_window(&handle, &window, &saved);
            } else {
                fit_launcher(&window);
            }

            /* A safety net for the hidden window.

               If the page never calls `ready` - a stylesheet that would not
               parse, a shader that would not compile - show it anyway so the
               player sees the failure instead of nothing at all. Four seconds
               for the launcher, which is a DOM page and should be up in
               milliseconds; twelve for the game, which has an asset pack to
               read first. */
            let w = window.clone();
            let grace = if start_at_game { 12 } else { 4 };
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(grace));
                if !SHOWN.load(Ordering::SeqCst) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });

            let _ = window.emit("synx://host-ready", ());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("SYNX failed to start");
}

/// Where the save lives, resolved without an `App`.
///
/// Tauri's own `app_data_dir` needs a handle we do not have yet at the point
/// the renderer has to be chosen. This mirrors it: `%APPDATA%` on Windows,
/// `$XDG_CONFIG_HOME` (or `~/.config`) on Linux, and `~/Library/Application
/// Support` on macOS, all under the bundle identifier.
fn dirs_app_data() -> Option<std::path::PathBuf> {
    const ID: &str = "com.synx.racing";
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(|p| std::path::PathBuf::from(p).join(ID))
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".config")))
            .map(|p| p.join(ID))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Application Support").join(ID))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(ID))
    }
}
