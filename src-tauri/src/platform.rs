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
/// WINDOWS ONLY, AND COMPILED ONLY THERE. A command line is how WebView2 is
/// configured and it is the only webview in the set that works that way:
/// WebKitGTK reads the environment instead (see [`apply_env`]) and WKWebView
/// takes neither. There used to be an empty stub here for the other two so
/// the name always resolved, and because the one call site is itself behind
/// a Windows cfg, that stub was a function nothing could ever call - which
/// every non-Windows build reported, correctly, as dead code.
/// `vsync` is a webview environment flag, not a game setting: Chromium's
/// compositor decides when a frame is presented, and nothing inside the page
/// can ask it not to wait for the display. That is why it is here and why
/// changing it costs a relaunch, exactly as the renderer does.
#[cfg(target_os = "windows")]
pub fn browser_args(r: Renderer, vsync: bool) -> String {
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

       `tools/smoke.py launcher` drives the real host - it opens the launcher,
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
    /* TEARING, ON PURPOSE.

       The row said "OFF can tear" and did nothing whatsoever - the flag was
       stored, sanitised, unit-tested and never read by anything. These are the
       two switches that actually turn it off: the first stops the GPU process
       waiting for the display, the second removes the compositor's own cap,
       which on its own holds the page at the refresh rate even with vsync
       disabled. Both are needed; either alone leaves the frame rate pinned. */
    if !vsync {
        a.push_str("--disable-gpu-vsync --disable-frame-rate-limit ");
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
///
/// THREE PLATFORMS, NOT TWO. This used to ask only whether it was Windows
/// and call everything else WebKitGTK, which on a Mac is a bug report that
/// names the wrong graphics stack - the webview there is WKWebView on Metal
/// and has never been through GTK or llvmpipe in its life. A diagnostic that
/// confidently states something untrue is worse than one that says nothing,
/// because it is the line whoever reads the report starts from.
///
/// macOS has no software fall-back to name, either. `apply_env` sets nothing
/// there and there is no command line to set, so the CPU renderer is a
/// launcher row that cannot be honoured rather than a path that exists, and
/// it says so instead of claiming a rasteriser it has not selected.
pub fn describe(r: Renderer) -> &'static str {
    #[cfg(target_os = "windows")]
    {
        match r {
            Renderer::Gpu => "WebView2 / ANGLE / Direct3D 11",
            Renderer::Cpu => "WebView2 / ANGLE / SwiftShader (software)",
        }
    }
    #[cfg(target_os = "macos")]
    {
        match r {
            Renderer::Gpu => "WKWebView / Metal",
            Renderer::Cpu => "WKWebView / Metal (no software path on this platform)",
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        match r {
            Renderer::Gpu => "WebKitGTK / OpenGL",
            Renderer::Cpu => "WebKitGTK / llvmpipe (software)",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WHICHEVER PLATFORM THIS IS BUILT FOR, the description has to name the
    /// webview that platform actually uses, and the two renderers have to be
    /// distinguishable from one another. Checked as a property because the
    /// wording is a presentation decision and the correctness is not.
    #[test]
    fn every_platform_names_its_own_webview() {
        let gpu = describe(Renderer::Gpu);
        let cpu = describe(Renderer::Cpu);
        let want = if cfg!(target_os = "windows") {
            "WebView2"
        } else if cfg!(target_os = "macos") {
            "WKWebView"
        } else {
            "WebKitGTK"
        };
        assert!(gpu.contains(want), "GPU says {gpu:?}, which is not {want}");
        assert!(cpu.contains(want), "CPU says {cpu:?}, which is not {want}");
        assert_ne!(gpu, cpu, "the two renderers read the same");
        // ...and no platform describes another platform's stack
        for other in ["WebView2", "WKWebView", "WebKitGTK"] {
            if other == want {
                continue;
            }
            assert!(!gpu.contains(other) && !cpu.contains(other),
                "this build claims to be running {other}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_two_paths_ask_for_different_backends() {
        let gpu = browser_args(Renderer::Gpu, true);
        let cpu = browser_args(Renderer::Cpu, true);
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

    /// VERTICAL SYNC has to reach the command line, because there is nowhere
    /// else it can be applied. This is the regression test for a row that was
    /// shipped doing nothing at all.
    #[cfg(target_os = "windows")]
    #[test]
    fn vsync_off_actually_asks_for_it() {
        let on = browser_args(Renderer::Gpu, true);
        let off = browser_args(Renderer::Gpu, false);
        assert!(!on.contains("disable-gpu-vsync"), "vsync ON must not disable it");
        assert!(off.contains("disable-gpu-vsync"), "vsync OFF did not reach the webview");
        // ...and the compositor's own cap, which holds the rate on its own
        assert!(off.contains("disable-frame-rate-limit"));
    }
}
