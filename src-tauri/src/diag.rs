//! Diagnostics: what happened, but only when something went wrong.
//!
//! # The rule
//!
//! **A successful run leaves nothing behind.** No log file, no directory, no
//! growing folder of yesterday's sessions. A game that writes a megabyte of
//! trace every time it starts is a game whose logs nobody reads, and the one
//! that matters is buried under fifty that do not.
//!
//! So everything is collected in memory as it happens and thrown away at exit.
//! It is written to disk only when there is a reason: a panic, a front end
//! that reported it could not start, or a previous run that died without
//! saying goodbye.
//!
//! # How a crash is caught when nothing can be written
//!
//! The hard case is the one the player actually hits: a graphics driver that
//! takes the process down with it. There is no unwinding, no panic hook, no
//! chance to write anything - the process is simply gone, and the next run
//! knows nothing about it.
//!
//! So the risky steps leave a BREADCRUMB. Before doing something that can kill
//! the process, a one-line marker is written naming the step; when it returns,
//! the marker is deleted. A marker still present at the next startup means the
//! previous run died inside that step, and that is when the report is written
//! - with the step named. It costs one small file write per launch and it is
//! the only way to report a failure that leaves no survivor.
//!
//! # What goes in a report
//!
//! Enough to answer "why did it not start on THIS machine" without a
//! conversation: the OS and its version, the CPU, the memory, the graphics
//! path the host chose, the webview's own version, every monitor, the relevant
//! environment, and whatever the front end managed to say before it stopped -
//! including the WebGL vendor and renderer strings, which are usually the
//! whole answer.

use std::fmt::Write as _;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The in-memory trace. Bounded, because a run that fails after two hours
/// should still produce a readable file rather than a hundred megabytes.
static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
const MAX_LINES: usize = 400;

pub const REPORT_NAME: &str = "synx-launch-report.txt";
pub const BREADCRUMB_NAME: &str = "synx-inflight.tmp";

/// Seconds since the process started, as a stamp a reader can follow.
fn stamp() -> String {
    use std::sync::OnceLock;
    static START: OnceLock<std::time::Instant> = OnceLock::new();
    let t0 = START.get_or_init(std::time::Instant::now);
    format!("{:8.3}", t0.elapsed().as_secs_f64())
}

/// Record a line. Cheap, allocation-bounded, and safe to call from anywhere.
pub fn note(line: impl AsRef<str>) {
    let Ok(mut v) = LINES.lock() else { return };
    if v.len() >= MAX_LINES {
        // Keep the beginning - which is the startup sequence, and where the
        // answer usually is - and drop from the middle.
        v.drain(MAX_LINES / 2..MAX_LINES / 2 + 1);
    }
    v.push(format!("[{}] {}", stamp(), line.as_ref()));
}

fn trace() -> String {
    LINES.lock().map(|v| v.join("\n")).unwrap_or_default()
}

// ------------------------------------------------------------ the machine --

/// Everything about this computer that could plausibly explain a failure to
/// start. Serialised for the launcher's own diagnostics panel as well as for
/// the report, so the two can never describe different machines.
#[derive(serde::Serialize, Clone)]
pub struct SystemReport {
    pub os: String,
    pub os_version: String,
    pub arch: &'static str,
    pub cores: usize,
    pub memory: String,
    pub webview: String,
    pub graphics: String,
    pub exe: String,
    pub save_dir: String,
    pub monitors: Vec<String>,
    pub env: Vec<String>,
}

/// The OS version, asked of the platform in its own language.
///
/// A subprocess is a heavy way to learn a version number, which is why this is
/// only ever called while building a report or filling the launcher's
/// diagnostics panel - never on the startup path.
fn os_version() -> String {
    #[cfg(target_os = "windows")]
    {
        // `cmd /c ver` prints e.g. "Microsoft Windows [Version 10.0.26200.1234]"
        if let Ok(out) = std::process::Command::new("cmd").args(["/c", "ver"]).output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/etc/os-release") {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                    return v.trim_matches('"').to_string();
                }
            }
        }
        if let Ok(v) = std::fs::read_to_string("/proc/version") {
            return v.trim().to_string();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sw_vers").output() {
            let s = String::from_utf8_lossy(&out.stdout).replace('\n', "  ");
            if !s.trim().is_empty() {
                return s.trim().to_string();
            }
        }
    }
    "unknown".into()
}

/// Installed memory, where the platform will say without a dependency.
fn memory() -> String {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/proc/meminfo") {
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("MemTotal:") {
                    return v.trim().to_string();
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if let Ok(n) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                return format!("{} MB", n / 1024 / 1024);
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        /* No dependency and no WMI: the environment variable every Windows
           carries is the processor count, and the memory needs an API call we
           would have to pull the `windows` crate in for. PowerShell knows, and
           this only ever runs while a report is being written. */
        if let Ok(out) = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
        {
            if let Ok(n) = String::from_utf8_lossy(&out.stdout).trim().parse::<u64>() {
                return format!("{} MB", n / 1024 / 1024);
            }
        }
    }
    "unknown".into()
}

/// The environment that actually changes how the webview renders. Only these:
/// dumping the whole environment into a file a player may post publicly is how
/// tokens and paths end up on a forum.
const ENV_OF_INTEREST: &[&str] = &[
    "SYNX_DEBUG_PORT",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "LIBGL_ALWAYS_SOFTWARE",
    "GALLIUM_DRIVER",
    "MESA_LOADER_DRIVER_OVERRIDE",
    "__NV_PRIME_RENDER_OFFLOAD",
    "DRI_PRIME",
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
];

pub fn system(graphics: &str, save_dir: String, monitors: Vec<String>) -> SystemReport {
    SystemReport {
        os: std::env::consts::OS.to_string(),
        os_version: os_version(),
        arch: std::env::consts::ARCH,
        cores: std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
        memory: memory(),
        webview: tauri::webview_version().unwrap_or_else(|_| "unknown".into()),
        graphics: graphics.to_string(),
        exe: std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        save_dir,
        monitors,
        env: ENV_OF_INTEREST
            .iter()
            .filter_map(|k| std::env::var(k).ok().map(|v| format!("{k}={v}")))
            .collect(),
    }
}

// ------------------------------------------------------------ breadcrumbs --

/// Mark that a step which can take the process down has begun.
pub fn begin_step(dir: Option<&std::path::Path>, step: &str) {
    note(format!("begin: {step}"));
    let Some(dir) = dir else { return };
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(BREADCRUMB_NAME), step);
}

/// ...and that it survived.
pub fn end_step(dir: Option<&std::path::Path>, step: &str) {
    note(format!("ok:    {step}"));
    let Some(dir) = dir else { return };
    let _ = std::fs::remove_file(dir.join(BREADCRUMB_NAME));
}

/// What the previous run died inside, if it died.
pub fn take_breadcrumb(dir: Option<&std::path::Path>) -> Option<String> {
    let dir = dir?;
    let p = dir.join(BREADCRUMB_NAME);
    let step = std::fs::read_to_string(&p).ok()?;
    let _ = std::fs::remove_file(&p);
    Some(step)
}

// ---------------------------------------------------------------- writing --

/// Write a report and return where it went.
///
/// `reason` is the headline - what a reader needs in the first line - and
/// `extra` is whatever the front end could tell us, which for a graphics
/// failure is usually the whole answer.
pub fn write_report(
    dir: Option<&std::path::Path>,
    reason: &str,
    sys: &SystemReport,
    extra: Option<&serde_json::Value>,
) -> Option<String> {
    let dir = dir?;
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(REPORT_NAME);

    let mut s = String::new();
    let when = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(s, "SYNX launch report");
    let _ = writeln!(s, "==================");
    let _ = writeln!(s);
    let _ = writeln!(s, "WHAT WENT WRONG");
    let _ = writeln!(s, "  {reason}");
    let _ = writeln!(s);
    let _ = writeln!(s, "  build         SYNX {}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(s, "  written       unix {when}");
    let _ = writeln!(s);
    let _ = writeln!(s, "THIS MACHINE");
    let _ = writeln!(s, "  os            {} ({})", sys.os_version, sys.os);
    let _ = writeln!(s, "  arch          {}", sys.arch);
    let _ = writeln!(s, "  cores         {}", sys.cores);
    let _ = writeln!(s, "  memory        {}", sys.memory);
    let _ = writeln!(s, "  webview       {}", sys.webview);
    let _ = writeln!(s, "  graphics      {}", sys.graphics);
    let _ = writeln!(s, "  executable    {}", sys.exe);
    let _ = writeln!(s, "  save folder   {}", sys.save_dir);
    for (i, m) in sys.monitors.iter().enumerate() {
        let _ = writeln!(s, "  monitor {i}     {m}");
    }
    if sys.env.is_empty() {
        let _ = writeln!(s, "  environment   nothing relevant set");
    } else {
        for e in &sys.env {
            let _ = writeln!(s, "  environment   {e}");
        }
    }
    if let Some(x) = extra {
        let _ = writeln!(s);
        let _ = writeln!(s, "WHAT THE GAME REPORTED");
        let pretty = serde_json::to_string_pretty(x).unwrap_or_else(|_| x.to_string());
        for line in pretty.lines() {
            let _ = writeln!(s, "  {line}");
        }
    }
    let _ = writeln!(s);
    let _ = writeln!(s, "WHAT HAPPENED, IN ORDER");
    let t = trace();
    if t.is_empty() {
        let _ = writeln!(s, "  (nothing was recorded)");
    } else {
        for line in t.lines() {
            let _ = writeln!(s, "  {line}");
        }
    }
    let _ = writeln!(s);
    let _ = writeln!(s, "WHAT TO TRY");
    let _ = writeln!(s, "  1. Open the launcher and set RENDERER to SOFTWARE. It is slow, and it");
    let _ = writeln!(s, "     works on machines whose driver cannot give a 3D context at all.");
    let _ = writeln!(s, "  2. Lower RENDER SCALE and set PRESET to LOW.");
    if sys.os == "windows" && sys.webview == "unknown" {
        let _ = writeln!(s, "  3. WebView2 could not be found. Install the Microsoft Edge WebView2");
        let _ = writeln!(s, "     Runtime - the game cannot draw anything without it.");
    } else if sys.os == "linux" {
        let _ = writeln!(s, "  3. Check that webkit2gtk is installed, and try");
        let _ = writeln!(s, "     WEBKIT_DISABLE_COMPOSITING_MODE=1 in the environment.");
    }

    std::fs::write(&path, s).ok()?;
    Some(path.to_string_lossy().into_owned())
}
