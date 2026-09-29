//! Where the SYNX site is, and what counts as being on it.
//!
//! The launcher's update notice opens the site's download section in a window
//! of its own (see `open_site` in main.rs). Everything that decides WHERE that
//! window may go is here, apart from the window, so it can be tested without
//! one: the address is built from what was compiled in, never from anything a
//! page hands over, and the window stays on exactly one host.
//!
//! js/connectivity.js carries the same address for the probe it sends there.

/// The SYNX site - where the builds are.
pub const SITE: &str = "https://synx-racing.vercel.app";
/// Its host, which is the whole of what the site window may show.
pub const HOST: &str = "synx-racing.vercel.app";
/// The label of the one window the site opens in.
pub const WINDOW: &str = "site";

/// The sections a caller may ask for. Anything else is the top of the page.
pub fn section(name: Option<&str>) -> &'static str {
    match name {
        Some("download") => "download",
        Some("faq") => "faq",
        _ => "",
    }
}

/// The site, told who is asking: this build's version, platform and
/// architecture, so its download section compares against the right version
/// and picks the right file rather than guessing from a user agent.
pub fn url(section: &str, version: &str, os: &str, arch: &str) -> Option<tauri::Url> {
    let mut u = tauri::Url::parse(SITE).ok()?;
    u.query_pairs_mut()
        .append_pair("from", "synx")
        .append_pair("v", version)
        .append_pair("os", os)
        .append_pair("arch", arch);
    if !section.is_empty() {
        u.set_fragment(Some(section));
    }
    Some(u)
}

/// Is this address the site itself, rather than somewhere it links to? The
/// scheme, the parsed host and the port, compared exactly - so a look-alike
/// host, a `site@elsewhere` address, plain http or another port on the same
/// name are all somewhere else. (`port()` is None for https's own 443,
/// written or not.)
pub fn on_site(u: &tauri::Url) -> bool {
    u.scheme() == "https" && u.host_str() == Some(HOST) && u.port().is_none()
}

/// A web address, which is the only kind the site window may hand to the
/// desktop's browser - never a file, never a protocol handler.
pub fn is_web(u: &tauri::Url) -> bool {
    matches!(u.scheme(), "https" | "http")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn the_address_says_who_is_asking() {
        let a = url("download", "1.0.3", "windows", "x86_64").unwrap();
        assert_eq!(
            a.as_str(),
            "https://synx-racing.vercel.app/?from=synx&v=1.0.3&os=windows&arch=x86_64#download"
        );
        assert!(on_site(&a));
        let top = url("", "1.0.3", "macos", "aarch64").unwrap();
        assert_eq!(top.fragment(), None);
    }

    #[test]
    fn only_known_sections_are_asked_for() {
        assert_eq!(section(Some("download")), "download");
        assert_eq!(section(Some("faq")), "faq");
        assert_eq!(section(Some("../../etc")), "");
        assert_eq!(section(Some("download#x")), "");
        assert_eq!(section(None), "");
    }

    #[test]
    fn the_window_stays_on_the_site() {
        assert!(on_site(&u("https://synx-racing.vercel.app/")));
        assert!(on_site(&u("https://synx-racing.vercel.app/#faq")));
        assert!(on_site(&u("https://SYNX-RACING.vercel.app/")), "hosts compare lower-cased");
        assert!(on_site(&u("https://synx-racing.vercel.app:443/")), "443 is https's own port");
        assert!(!on_site(&u("https://synx-racing.vercel.app:8443/")));
        // everything below is somewhere else
        assert!(!on_site(&u("http://synx-racing.vercel.app/")));
        assert!(!on_site(&u("https://synx-racing.vercel.app.evil.example/")));
        assert!(!on_site(&u("https://evil.example/synx-racing.vercel.app")));
        assert!(!on_site(&u("https://synx-racing.vercel.app@evil.example/")));
        assert!(!on_site(&u("https://github.com/suryanarayanrenjith/SYNX/releases")));
        assert!(!on_site(&u("file:///C:/Windows/System32/calc.exe")));
    }

    #[test]
    fn only_web_addresses_go_to_the_browser() {
        assert!(is_web(&u("https://github.com/suryanarayanrenjith/SYNX/releases/download/v1.0.2/x.exe")));
        assert!(is_web(&u("http://example.com/")));
        assert!(!is_web(&u("file:///C:/Windows/System32/calc.exe")));
        assert!(!is_web(&u("ms-settings:privacy")));
        assert!(!is_web(&u("javascript:alert(1)")));
        assert!(!is_web(&u("mailto:someone@example.com")));
    }
}
