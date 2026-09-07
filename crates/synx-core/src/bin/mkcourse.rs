//! Emit the finished course for the multiplayer server to validate against.
//!
//!     cargo run -p synx-core --release --bin mkcourse -- \
//!         web/data/scene.json target/course.bin
//!
//! # Why the server does not generate its own
//!
//! It could: `track::build` is deterministic, seeded, and right here. Two
//! things make a precomputed file the better answer.
//!
//! THE COLD START.  The free instance the server is deployed to spins down
//! after fifteen idle minutes and takes about a minute to come back. Every
//! second of work at boot is a second a player sits looking at a lobby that
//! says CONNECTING, and generating twenty-nine thousand samples on a tenth of
//! a CPU is not free. Reading a mapped file is.
//!
//! THE AGREEMENT.  A road generated twice is a road that can differ twice.
//! This file is emitted by the game's own core, from the game's own shipped
//! centreline, by the same function the game calls - so the server is not
//! reimplementing the course, it is being handed it.
//!
//! # The format
//!
//! ```text
//!   magic      8   "SYNXCRS1"
//!   count      4   u32, samples
//!   step       4   f32, world units between samples
//!   length     4   f32, total arc length
//!   shipped    4   u32, how many samples are the authored mesh
//!   samples    count * 16   f32 x, y, z, yaw
//!   tunnel     count        u8
//!   checksum   4   u32, FNV-1a over everything above
//! ```
//!
//! `f32` throughout because the server uses this for containment and
//! plausibility tests whose tolerances are measured in whole units, and the
//! worst-case `f32` step out at fifty thousand units is four millimetres.

use std::io::Write;
use std::path::PathBuf;

use synx_core::track::{self, Centreline};

/// Hand-rolled rather than pulled from a JSON crate: the shape being read here
/// is fixed and flat, and a parser for it is a few lines against a dependency
/// the core does not otherwise carry.
fn parse_centre(src: &str) -> Centreline {
    fn array_after(src: &str, key: &str) -> Vec<f64> {
        let Some(k) = src.find(key) else { return Vec::new() };
        let rest = &src[k + key.len()..];
        let Some(open) = rest.find('[') else { return Vec::new() };
        let Some(close) = rest[open..].find(']') else { return Vec::new() };
        rest[open + 1..open + close]
            .split(',')
            .filter_map(|t| t.trim().parse::<f64>().ok())
            .collect()
    }
    fn scalar_after(src: &str, key: &str) -> f64 {
        let Some(k) = src.find(key) else { return 0.0 };
        let rest = &src[k + key.len()..];
        let end = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == '+'))
            .unwrap_or(rest.len());
        rest[..end].trim().parse::<f64>().unwrap_or(0.0)
    }

    let start = src.find("\"centre\"").expect("scene.json has no centre");
    let block = &src[start..];
    let mut c = Centreline {
        x: array_after(block, "\"x\":"),
        y: array_after(block, "\"y\":"),
        z: array_after(block, "\"z\":"),
        yaw: array_after(block, "\"yaw\":"),
        curv: array_after(block, "\"curv\":"),
        tunnel: array_after(block, "\"tunnel\":").iter().map(|v| *v as u8).collect(),
        step: scalar_after(block, "\"step\":"),
        count: scalar_after(block, "\"count\":") as usize,
        shipped_count: 0,
    };
    if c.count == 0 {
        c.count = c.x.len();
    }
    if c.y.len() < c.count {
        c.y = vec![0.0; c.count];
    }
    c.shipped_count = c.count;
    c
}

fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= *b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scene = args.get(1).cloned().unwrap_or_else(|| "web/data/scene.json".into());
    let out = PathBuf::from(
        args.get(2).cloned().unwrap_or_else(|| "target/course.bin".into()),
    );

    let src = std::fs::read_to_string(&scene).unwrap_or_else(|e| panic!("read {scene}: {e}"));
    let shipped = parse_centre(&src);
    println!(
        "shipped centreline: {} samples, step {}, {:.0} units",
        shipped.count,
        shipped.step,
        shipped.count as f64 * shipped.step
    );

    // Exactly what js/wasm.js asks for at load, so the server validates against
    // the road the game is actually driving.
    let c = track::build_course(&shipped, track::COURSE_LENGTH);
    println!(
        "full course:        {} samples, {:.0} units, {} shipped",
        c.count,
        c.count as f64 * c.step,
        c.shipped_count
    );

    let mut body: Vec<u8> = Vec::with_capacity(24 + c.count * 17);
    body.extend_from_slice(b"SYNXCRS1");
    body.extend_from_slice(&(c.count as u32).to_le_bytes());
    body.extend_from_slice(&(c.step as f32).to_le_bytes());
    body.extend_from_slice(&((c.count as f64 * c.step) as f32).to_le_bytes());
    body.extend_from_slice(&(c.shipped_count as u32).to_le_bytes());
    for i in 0..c.count {
        body.extend_from_slice(&(c.x[i] as f32).to_le_bytes());
        body.extend_from_slice(&(c.y[i] as f32).to_le_bytes());
        body.extend_from_slice(&(c.z[i] as f32).to_le_bytes());
        body.extend_from_slice(&(c.yaw[i] as f32).to_le_bytes());
    }
    body.extend_from_slice(&c.tunnel[..c.count]);
    let sum = fnv1a(&body);
    body.extend_from_slice(&sum.to_le_bytes());

    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    std::fs::File::create(&out)
        .unwrap_or_else(|e| panic!("create {}: {e}", out.display()))
        .write_all(&body)
        .unwrap();
    println!(
        "wrote {} ({:.0} KB, checksum {:08x})",
        out.display(),
        body.len() as f64 / 1024.0,
        sum
    );
}
