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
//! and PLAY reshapes that window to the chosen mode; the page then moves
//! itself to `index.html`.
//!
//! THE RESHAPE IS THIS SIDE AND THE NAVIGATION IS NOT, and the split is not
//! arbitrary. `launch_game` used to do both, which meant the page was
//! replaced while that command's own invoke was still in flight. On macOS
//! that is fatal: wry's URL scheme handler completes its task against a page
//! that has gone, panics inside an `extern "C"` function that may not
//! unwind, and the process aborts (tauri-apps/tauri#12338). Windows and
//! Linux tolerate the same sequence, so it only ever failed on a Mac.
//! Returning first and letting the front end navigate leaves nothing
//! pending when the page changes.
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

mod clips;
mod diag;
mod launcher;
mod platform;
mod save;
mod site;

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
const GAME_TITLE: &str = "SYNX - Synthwave eXtreme Racing";

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
    /// Whether the webview was started with vertical sync. The page cannot
    /// find this out for itself - it is a process argument, decided before
    /// any script runs - and it changes how the game paces itself: with the
    /// compositor no longer holding the loop at the refresh rate, nothing
    /// else will unless the game does it. See gpuBusy in js/game.js.
    vsync: bool,
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
        version: env!("SYNX_VERSION"),
        persistent: save::dir(&app).is_some(),
        vsync: startup_vsync(),
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
            let pos = m.position();
            let name = m.name().cloned().unwrap_or_else(|| "DISPLAY".into());
            monitors.push(launcher::MonitorInfo {
                primary: Some(&name) == primary_name.as_ref(),
                name,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale: m.scale_factor(),
            });
        }
    }
    if monitors.is_empty() {
        monitors.push(launcher::MonitorInfo {
            name: "DISPLAY".into(),
            x: 0,
            y: 0,
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
        version: env!("SYNX_VERSION"),
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
    open_with_system(p.as_os_str())
}

/// Hand a file or an address to whatever the desktop opens it with.
///
/// No shell plugin, and no shell. Each platform's own opener is invoked
/// directly with the target as an argument, so nothing is ever interpreted as
/// a command - the target is data, and a folder name with a space or an
/// ampersand in it, or an address with a query string, cannot become anything
/// else.
fn open_with_system(target: &std::ffi::OsStr) -> bool {
    #[cfg(target_os = "windows")]
    let r = diag::quiet(std::process::Command::new("rundll32"))
        .args(["url.dll,FileProtocolHandler"])
        .arg(target)
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(target).spawn();
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open").arg(target).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let r: std::io::Result<std::process::Child> =
        Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "no opener"));
    r.is_ok()
}

// ------------------------------------------------------------- the site ----

/// Hand an address to the desktop's own browser. Web addresses only - see
/// `site::is_web` - so the site window can never become a way to open a file
/// or run a protocol handler.
fn open_in_browser(u: &tauri::Url) -> bool {
    site::is_web(u) && open_with_system(std::ffi::OsStr::new(u.as_str()))
}

/// The script that marks a page as running in a development build: read once
/// by js/guard.js, before anything else on the page. Never compiled into a
/// shipped build.
#[cfg(any(debug_assertions, feature = "harness"))]
fn dev_flag() -> &'static str {
    "Object.defineProperty(window, 'SYNX_DEV', { value: true });"
}

/// THE GAME WINDOW SHOWS THE GAME, and nothing else.
///
/// Its pages are this app's own, served from the bundle: `tauri://localhost`
/// on macOS and Linux, `http(s)://tauri.localhost` on Windows. Anything else
/// it is asked to load - a link in a page, a redirect, a script setting
/// `location` - is not the game, and a window holding the game's IPC bridge
/// has no business rendering it. A web address goes to the desktop's browser
/// instead, the way the site window treats a link off the site; anything
/// that is not one goes nowhere.
fn is_app_page(u: &tauri::Url) -> bool {
    match u.scheme() {
        "tauri" => u.host_str() == Some("localhost"),
        "http" | "https" => u.host_str() == Some("tauri.localhost"),
        "about" => u.path() == "blank",
        _ => false,
    }
}

/// WebView2's own browser furniture, off: the right-click menu (back,
/// reload, save as, print) and the browser's keys - F5 and Ctrl+R reload,
/// Ctrl+F finds, Ctrl+P prints, F12 and Ctrl+Shift+I would look for an
/// inspector - none of which a game has any use for, and several of which
/// throw the race away mid-lap. Release builds only: a debug build keeps all
/// of it, inspector included. Tauri does not expose these two settings, so
/// they are set through the same WebView2 bindings it is built on. The page
/// blocks the same keys and the menu itself (see js/guard.js), which is what
/// covers WebKitGTK and WKWebView.
#[cfg(all(target_os = "windows", not(debug_assertions)))]
fn lock_webview2(window: &WebviewWindow) {
    let _ = window.with_webview(|wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        // SAFETY: COM calls on the webview's own controller, made on the
        // thread `with_webview` runs them on, which is the one that owns it.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(s) = core.Settings() else { return };
            let _ = s.SetAreDevToolsEnabled(false);
            let _ = s.SetAreDefaultContextMenusEnabled(false);
            let _ = s.SetIsStatusBarEnabled(false);
            if let Ok(s3) = s.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

/// Open the SYNX site in a window of its own, at one of its sections.
///
/// ASYNC ON PURPOSE. A window built from a synchronous command deadlocks on
/// Windows - the command holds the thread the new webview needs - which is
/// Tauri's own documented rule, and the same trap the note at the top of this
/// file describes for the game window.
///
/// WHAT THE WINDOW MAY DO: show the site, and nothing else.
///
///   * It stays on the site. A link off it - GitHub, a download - goes to the
///     desktop's browser instead, which handles a 50 MB download with a
///     progress bar and a place to put it, where a game's webview would
///     either do nothing or do it silently.
///   * It cannot reach the game. Tauri refuses every command from a remote
///     origin unless a capability grants it, and this app grants none - so
///     the page in this window cannot touch the save, the settings or quit.
///   * On Windows it is built with the main window's exact WebView2
///     arguments: one process shares one browser environment, and a second
///     window asking for a different one is refused outright.
///
/// Opening it again while it is open brings it forward at the new section.
#[tauri::command]
async fn open_site(app: tauri::AppHandle, section: Option<String>) -> Result<bool, String> {
    /* Built here from what was compiled in - the page only names a section -
       so the window can never be pointed anywhere else. */
    let url = site::url(
        site::section(section.as_deref()),
        env!("SYNX_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    )
    .ok_or("the site's address could not be built")?;

    if let Some(w) = app.get_webview_window(site::WINDOW) {
        let _ = w.navigate(url);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(true);
    }

    let nav = app.clone();
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(&app, site::WINDOW, tauri::WebviewUrl::External(url))
        .title(format!("SYNX // {}", site::HOST))
        .inner_size(1180.0, 800.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .center()
        .focused(true)
        .theme(Some(tauri::Theme::Dark))
        // no inspector here either in a shipped build - see the game window
        .devtools(cfg!(debug_assertions))
        .on_navigation(|u| {
            if site::on_site(u) {
                return true;
            }
            open_in_browser(u);
            false
        })
        // target=_blank and window.open: the same decision, in the same window.
        .on_new_window(move |u, _features| {
            if site::on_site(&u) {
                if let Some(w) = nav.get_webview_window(site::WINDOW) {
                    let _ = w.navigate(u);
                }
            } else {
                open_in_browser(&u);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // ...and anything that tries to download in here goes to the browser too.
        .on_download(|_webview, event| {
            if let tauri::webview::DownloadEvent::Requested { url, .. } = event {
                open_in_browser(&url);
            }
            false
        });

    #[cfg(target_os = "windows")]
    {
        b = b.additional_browser_args(&platform::browser_args(startup_renderer(), startup_vsync()));
    }

    b.build().map_err(|e| format!("the site window could not be opened: {e}"))?;
    diag::note("opened the SYNX site");
    Ok(true)
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
    /* TWO SETTINGS COST A RESTART, not one. Vertical sync is the other: it is
       a switch on the webview's command line, the command line is fixed when
       the environment is created, and this window's environment was created
       before the player touched the row. Relaunching is what makes the row
       true - the alternative is the one this code already rejected once, a
       label for something that does not happen. */
    if parsed.renderer() != startup_renderer() || parsed.vsync != startup_vsync() {
        let exe = std::env::current_exe().map_err(|e| format!("cannot find the executable: {e}"))?;
        // ...quietly, like every other child here - see diag::quiet
        diag::quiet(std::process::Command::new(exe))
            .arg("--play")
            .spawn()
            .map_err(|e| format!("could not restart for the renderer change: {e}"))?;
        app.exit(0);
        return Ok(true);
    }

    let window = app
        .get_webview_window(MAIN)
        .ok_or_else(|| "the window has gone".to_string())?;

    apply_window(&app, &window, &parsed);

    /* AND THE PAGE IS NOT CHANGED HERE.

       This used to end with `window.navigate(...)`, which replaced the page
       while this very command's invoke was still waiting to return. On
       macOS that aborts the process - see the note at the top of this file -
       and it did so on both Intel and Apple silicon, which is why the game
       reached the photosensitivity notice and then died there, over and
       over, on a Mac and nowhere else.

       So the command returns, the response is delivered, and the launcher
       page moves itself. The front end resolves the address relative to its
       own, which is also what the code removed from here was doing by hand:
       the origin a Tauri asset is served from is not the same string on
       every platform, so neither side may write it out. */
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
            /* FULLSCREEN HAS TO BE TOLD WHICH SCREEN, and it cannot be told
               directly. `set_fullscreen(true)` fills the monitor the window is
               ALREADY ON - that is what the platform layer means by it - so
               calling it on a window still sitting where the launcher left it
               fills the launcher's display and silently ignores the setting.
               This was the reported fault: choosing a display did nothing.

               Windowed and borderless never had it, because both position the
               window themselves on the way past.

               So the move happens first, and it happens in the SAME main-thread
               block as the fullscreen call - see resize_on_main. Splitting them
               is what makes it a race rather than a sequence. */
            let _ = window.set_decorations(true);
            let _ = window.set_resizable(true);
            resize_on_main(app, window, Target::Fullscreen(s.monitor));
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
    /// monitor index. Positioned first, then handed to the platform's own
    /// fullscreen path; see the note in `apply_window`.
    Fullscreen(usize),
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
            Target::Fullscreen(idx) => {
                /* Put it on the target screen BEFORE asking for fullscreen.
                   Position and size both, because a window smaller than the
                   monitor can still have its centre on the previous one on a
                   mixed-DPI desktop - and it is the centre the platform uses
                   to decide which display a window belongs to. */
                if let Some(mon) = monitors.get(idx).or_else(|| monitors.first()) {
                    let pos = *mon.position();
                    let size = *mon.size();
                    let _ = w.set_fullscreen(false);
                    let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
                    let _ = w.set_size(tauri::PhysicalSize::new(size.width, size.height));
                }
                let _ = w.set_fullscreen(true);
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
/* ------------------------------------------------------------- RECORDING --
 *
 * The clip arrives here already encoded - the whole of that work happens in
 * the webview's own process, in the recorder's worker thread, so a frame never
 * crosses this boundary. What crosses is one finished file per save.
 *
 * # It is a RAW BODY, and that is the fix
 *
 * This used to take `bytes: Vec<u8>`, which is an ordinary command argument
 * and therefore arrives as JSON. The page had to call `Array.from` on the
 * clip to produce it: a twenty-five megabyte picture became twenty-five
 * MILLION boxed JavaScript numbers, then a string about three times that size,
 * then a serde parse back into bytes on this side. That is seconds of a
 * completely unresponsive game on every save, and it was the whole of the
 * reported freeze.
 *
 * `tauri::ipc::Request` hands over the request body untouched instead, so the
 * page posts the `Uint8Array` itself and this reads the same bytes. The label
 * comes in a header, because the body is the file.
 */
#[tauri::command]
fn clip_write(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("the clip must be sent as a raw body, not as JSON".into());
    };
    if bytes.len() < 64 {
        return Err("the clip was empty".into());
    }
    /* The name is rebuilt HERE rather than trusted: it arrived from the page,
       and a string from the page that reaches a path is a string that gets
       checked on this side of the boundary. See clips::file_name. */
    let name = request
        .headers()
        .get("x-synx-clip")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let fallback = app.path().app_data_dir().ok();
    let dir = clips::dir(fallback.as_deref()).ok_or("nowhere to write clips")?;
    let stamp = stamp_now();
    let safe = clips::file_name(name, &stamp);
    clips::write(&dir, &safe, bytes)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("could not write the clip: {e}"))
}

/// Where clips go, for the options screen to print.
#[tauri::command]
fn clips_dir(app: tauri::AppHandle) -> String {
    let fallback = app.path().app_data_dir().ok();
    clips::dir(fallback.as_deref())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Show the folder in the platform's file manager.
#[tauri::command]
fn clips_open(app: tauri::AppHandle) -> bool {
    let fallback = app.path().app_data_dir().ok();
    let Some(dir) = clips::dir(fallback.as_deref()) else { return false };
    #[cfg(target_os = "windows")]
    let cmd = { let mut c = std::process::Command::new("explorer"); c.arg(&dir); c };
    #[cfg(target_os = "macos")]
    let cmd = { let mut c = std::process::Command::new("open"); c.arg(&dir); c };
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd = { let mut c = std::process::Command::new("xdg-open"); c.arg(&dir); c };
    diag::quiet(cmd).spawn().is_ok()
}

/// A sortable stamp, to the second, without pulling in a date library.
fn stamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    /* Days since the epoch, converted with the civil-from-days algorithm - the
       same arithmetic every date library uses, and four lines of it. */
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}-{:02}{:02}{:02}",
        y, m, d, tod / 3600, (tod % 3600) / 60, tod % 60
    )
}

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

/// ...and the vertical-sync setting it started with.
///
/// Kept for the same reason the renderer is: both are baked into the webview's
/// command line when its environment is created, so a change to either can
/// only take effect on a fresh process. See `launch_game`.
static STARTUP_VSYNC: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

fn startup_vsync() -> bool {
    *STARTUP_VSYNC.get().unwrap_or(&true)
}

fn main() {
    /* FIRST OF ALL, in a build that ships: no debugging switch arrives through
       the environment. See platform::lock_down. */
    platform::lock_down();

    /* Before anything else.

       The graphics backend and, on Linux, the compositing mode are read by the
       webview when it is created, so the preference has to be known and
       applied first. `app_data_dir` is not available until there is an App, so
       the directory is resolved by hand here - the same path Tauri will use. */
    let dir = dirs_app_data();
    let saved = launcher::load(dir.as_deref());
    let renderer = saved.renderer();
    let _ = STARTUP_RENDERER.set(renderer);
    let _ = STARTUP_VSYNC.set(saved.vsync);
    platform::apply_env(renderer);

    let skip = std::env::args().any(|a| a == "--play");
    SKIP_LAUNCHER.store(skip, Ordering::SeqCst);

    diag::note(format!(
        "start: SYNX {} on {} {}",
        env!("SYNX_VERSION"),
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
            open_site,
            clip_write,
            clips_dir,
            clips_open,
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
            .disable_drag_drop_handler()
            /* NO INSPECTOR IN A SHIPPED BUILD, on any platform. Without
               Tauri's `devtools` feature - which this crate does not enable -
               a release webview has none anyway; saying so here makes it a
               decision rather than a default, and the one place to read it. */
            .devtools(cfg!(debug_assertions))
            // ...and the game window stays on the game - see is_app_page
            .on_navigation(|u| {
                if is_app_page(u) {
                    return true;
                }
                open_in_browser(u);
                false
            })
            .on_new_window(|u, _features| {
                open_in_browser(&u);
                tauri::webview::NewWindowResponse::Deny
            });

            /* A DEVELOPMENT SESSION SAYS SO, and only one does. A debug build,
               or a test build made with `--features harness`, tells the page
               before any of its scripts run - which is what lets js/guard.js
               keep the development hooks the tools drive the game through. A
               shipped build says nothing, and the page treats it as what it
               is. */
            #[cfg(any(debug_assertions, feature = "harness"))]
            {
                b = b.initialization_script(dev_flag());
            }

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
                b = b.additional_browser_args(&platform::browser_args(renderer, startup_vsync()));
            }

            /* BUILDING THE WEBVIEW IS THE RISKY STEP.

               This is where a broken graphics driver takes the process down,
               and it is the single most common way this game fails to start on
               a machine it has never run on. The breadcrumb is what lets the
               NEXT run say so. */
            diag::begin_step(dir2.as_deref(), "creating the game window and its webview");
            let window = b.build()?;
            diag::end_step(dir2.as_deref(), "creating the game window and its webview");
            #[cfg(all(target_os = "windows", not(debug_assertions)))]
            lock_webview2(&window);

            /* ONE GAME, ONE PROCESS. The site window is a side trip (see
               open_site), and closing the game must not leave it open on its
               own with nothing behind it - so it goes when this one does, and
               the process ends with the last window as it always has. */
            let closer = handle.clone();
            window.on_window_event(move |e| {
                if let tauri::WindowEvent::Destroyed = e {
                    if let Some(w) = closer.get_webview_window(site::WINDOW) {
                        let _ = w.close();
                    }
                }
            });

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The game window loads the game's own pages and nothing else, on every
    /// platform's spelling of "the bundle".
    #[test]
    fn only_the_apps_own_pages_load_in_the_game_window() {
        let ok = [
            "tauri://localhost/index.html",
            "tauri://localhost/launcher.html#AUDIO",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/launcher.html",
            "about:blank",
        ];
        let refused = [
            "https://example.com/",
            "http://localhost:9222/",
            "http://127.0.0.1/index.html",
            "https://tauri.localhost.example.com/",
            "tauri://evil/index.html",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:config",
        ];
        for u in ok {
            assert!(is_app_page(&tauri::Url::parse(u).unwrap()), "{u} was refused");
        }
        for u in refused {
            assert!(!is_app_page(&tauri::Url::parse(u).unwrap()), "{u} was let in");
        }
    }
}
