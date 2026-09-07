//! Per-platform startup: the webview's own flags, and where the game's data
//! lives.
//!
//! SYNX runs on Windows through WebView2 and on Linux through WebKitGTK, and
//! the two are told how to render in completely different ways - one by a
//! Chromium command line, the other by environment variables read before the
//! webview process starts. Both are set here so the difference is in one file
//! rather than smeared through the host.
//!
//! # The renderer choice
//!
//! The renderer is GPU or CPU, and it has to be applied *before any window
//! exists* - a webview's graphics backend is chosen when its environment is
//! created and cannot be swapped underneath a running context. That is why the
//! choice lives on the launcher screen rather than in the game's options, and
//! why `main` resolves it (through `launcher::load`) before the builder runs.
//!
//! CPU is not a performance option. It is there because a machine whose driver
//! will not produce a working 3D context has to have something that runs, and
//! "the window opens and the screen is black" is the worst possible answer.

/// What the front end asked for last time it was open.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Renderer {
    /// The hardware path. What the game is built for.
    Gpu,
    /// Software rasterisation. Correct, and slow.
    Cpu,
}

/// The Chromium command line WebView2 is started with.
///
/// Only Windows uses this; on Linux it is ignored and [`apply_env`] does the
/// equivalent job.
#[cfg(target_os = "windows")]
pub fn browser_args(r: Renderer) -> String {
    // Common to both: the things a game wants from a webview that a document
    // viewer does not.
    let mut a = String::from(concat!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,ElasticOverscroll ",
        "--autoplay-policy=no-user-gesture-required ",
        "--disable-background-timer-throttling ",
        "--disable-renderer-backgrounding ",
        "--disable-backgrounding-occluded-windows ",
        "--disable-pinch --overscroll-history-navigation=0 ",
    ));
    /* A WAY IN, FOR THE BUILD ONLY.

       `tools/checklauncher.js` drives the real host - it opens the launcher,
       presses PLAY and checks that the window actually becomes the game -
       and to do that it has to attach a debugger to the webview. That is the
       one thing this process cannot be asked for after it has started.

       Gated on an environment variable that nothing sets in a shipped run, so
       a player's build never opens a port. It is read rather than compiled in
       because the test drives the RELEASE binary: a debug-only hook would be
       testing a different executable from the one that ships. */
    if let Ok(port) = std::env::var("SYNX_DEBUG_PORT") {
        if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() {
            a.push_str(&format!("--remote-debugging-port={port} "));
        }
    }
    match r {
        Renderer::Gpu => a.push_str(concat!(
            "--ignore-gpu-blocklist ",
            "--enable-gpu-rasterization ",
            "--enable-zero-copy ",
            "--enable-accelerated-2d-canvas ",
            // the one that matters on a laptop with two GPUs
            "--force_high_performance_gpu ",
            "--use-angle=d3d11 ",
        )),
        Renderer::Cpu => a.push_str(concat!(
            // SwiftShader: a complete, correct GL ES implementation on the CPU
            "--use-angle=swiftshader ",
            "--enable-unsafe-swiftshader ",
            "--disable-gpu-rasterization ",
        )),
    }
    a
}

#[cfg(not(target_os = "windows"))]
pub fn browser_args(_r: Renderer) -> String {
    String::new()
}

/// Configure the webview through the environment, for the platforms that are
/// told that way rather than by a command line.
///
/// # Safety of the timing
/// These have to be set before the webview is created, which is why this is
/// called at the very top of `main` rather than from `setup`.
pub fn apply_env(r: Renderer) {
    #[cfg(target_os = "linux")]
    {
        // WebKitGTK picks its compositing path from the environment. DMABUF
        // rendering is broken on a number of drivers and shows up as a blank
        // window, which is the single most common Linux webview complaint, so
        // it is disabled explicitly rather than left to chance.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        match r {
            Renderer::Gpu => {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "0");
            }
            Renderer::Cpu => {
                // force the software path all the way down
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
                std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
                std::env::set_var("GALLIUM_DRIVER", "llvmpipe");
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = r;
    }
}

/// A short human-readable description of the graphics path, for the options
/// screen and for a bug report.
pub fn describe(r: Renderer) -> &'static str {
    match (cfg!(target_os = "windows"), r) {
        (true, Renderer::Gpu) => "WebView2 / ANGLE / Direct3D 11",
        (true, Renderer::Cpu) => "WebView2 / ANGLE / SwiftShader (software)",
        (false, Renderer::Gpu) => "WebKitGTK / OpenGL",
        (false, Renderer::Cpu) => "WebKitGTK / llvmpipe (software)",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn the_two_paths_ask_for_different_backends() {
        let gpu = browser_args(Renderer::Gpu);
        let cpu = browser_args(Renderer::Cpu);
        assert!(gpu.contains("d3d11"));
        assert!(gpu.contains("force_high_performance_gpu"));
        assert!(cpu.contains("swiftshader"));
        assert!(!cpu.contains("d3d11"));
        // both keep the flags the game needs whatever it is rendering with
        for a in [&gpu, &cpu] {
            assert!(a.contains("autoplay-policy=no-user-gesture-required"));
            assert!(a.contains("disable-background-timer-throttling"));
        }
    }
}
