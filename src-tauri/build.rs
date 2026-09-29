//! Build script: Tauri's own step, and the version the game says it is.
//!
//! # THE VERSION IN THE EXECUTABLE
//!
//! The number in `Cargo.toml` is a floor, not a statement (see
//! tools/version.py): the release workflow stamps the real one in before it
//! builds, and a build made anywhere else used to report the floor - a
//! checkout of exactly the commit released as 1.0.2 called itself 1.0.0, and
//! the launcher's update notice then told it to update to itself.
//!
//! So the version compiled in (`SYNX_VERSION`, read by main.rs, diag.rs and
//! save.rs) is the newer of two answers:
//!
//!   * the stamped one, `CARGO_PKG_VERSION` - which in the release workflow IS
//!     the release, because it is written in before this runs;
//!   * the nearest release tag behind the commit being built, from
//!     `git describe` - which is the release a local build's code line is on.
//!
//! The workflow checks out without tags, so there the first answer stands
//! alone. A checkout with no git, no tags or no repository at all gets the
//! first answer too: nothing here can fail a build.

use std::path::Path;
use std::process::Command;

fn parse(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let mut it = v.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((a, b, c))
}

/// The nearest `vX.Y.Z` tag reachable from HEAD, if git can say.
fn described(root: &Path) -> Option<(u64, u64, u64)> {
    let out = Command::new("git")
        .args(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"])
        .current_dir(root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse(std::str::from_utf8(&out.stdout).ok()?)
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let root = Path::new(&manifest).parent().unwrap_or(Path::new(".")).to_path_buf();

    let stamped = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let version = match (parse(&stamped), described(&root)) {
        (Some(s), Some(t)) if t > s => format!("{}.{}.{}", t.0, t.1, t.2),
        (Some(_), _) => stamped.clone(),
        (None, Some(t)) => format!("{}.{}.{}", t.0, t.1, t.2),
        (None, None) => stamped.clone(),
    };
    println!("cargo:rustc-env=SYNX_VERSION={version}");

    /* Asked again when a tag arrives or HEAD moves - and only for paths that
       exist: a missing one would make cargo rerun this on every build. */
    let git = root.join(".git");
    for p in ["HEAD", "packed-refs", "refs/tags"] {
        let path = git.join(p);
        if path.exists() {
            println!("cargo:rerun-if-changed={}", path.display());
        }
    }

    tauri_build::build()
}
