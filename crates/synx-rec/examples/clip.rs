//! Write a sample clip, so the encoder can be opened rather than only tested.
//!
//!     cargo run -p synx-rec --release --example clip -- out.avi
//!
//! The tests prove the round trip against a decoder written beside them; this
//! proves the other half, which is that a real player opens the result. It
//! draws a moving synthwave-ish frame rather than noise, because a file full
//! of noise looks the same whether the chroma planes are the right way round
//! or not.

use synx_rec::Reel;

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "synx-sample.avi".into());
    let (w, h) = (854usize, 480usize);
    let fps = 30u32;
    let seconds = 4u32;

    /* The last argument is a byte budget, not megabytes - the ABI is what
       converts. Passing 128 here capped the ring at the one-megabyte floor and
       the sample came out a second long, which is the budget working. */
    let mut reel = Reel::new(w, h, fps, 75, 60_000, 128 << 20);
    let mut buf = vec![0u8; w * h * 3];
    let total = fps * seconds;

    for f in 0..total {
        let t = f as f32 / fps as f32;
        for y in 0..h {
            for x in 0..w {
                let u = x as f32 / w as f32;
                let v = y as f32 / h as f32;
                // a horizon with a grid running away from it, and a sun
                let horizon = 0.56f32;
                let (r, g, b);
                if v < horizon {
                    let sky = (horizon - v) / horizon;
                    let sun = ((u - 0.5).powi(2) * 4.0 + (v - 0.34).powi(2) * 9.0).sqrt();
                    let disc = (1.0 - (sun * 3.2).min(1.0)).max(0.0);
                    r = 0.10 + sky * 0.25 + disc * 0.90;
                    g = 0.02 + disc * 0.30;
                    b = 0.22 + sky * 0.45 + disc * 0.35;
                } else {
                    let d = (v - horizon) / (1.0 - horizon);
                    let z = 1.0 / (d + 0.03);
                    let along = (z * 0.6 - t * 6.0).fract().abs();
                    let across = (((u - 0.5) * z * 0.9).fract()).abs();
                    let line = if along < 0.06 || across < 0.05 { 1.0 } else { 0.0 };
                    r = 0.05 + line * 0.95;
                    g = 0.01 + line * 0.20;
                    b = 0.12 + line * 0.85;
                }
                let i = (y * w + x) * 3;
                buf[i] = (r.clamp(0.0, 1.0) * 255.0) as u8;
                buf[i + 1] = (g.clamp(0.0, 1.0) * 255.0) as u8;
                buf[i + 2] = (b.clamp(0.0, 1.0) * 255.0) as u8;
            }
        }
        reel.push(&buf, 3, f * (1000 / fps));
        if f == total / 2 {
            reel.mark(f * (1000 / fps), "SAMPLE");
        }
    }

    let mut out = Vec::new();
    let n = reel.save_all(&mut out);
    std::fs::write(&path, &out).expect("could not write the clip");
    println!(
        "{path}: {n} frames, {w}x{h} at {fps} fps, {:.2} MB  ({:.1} KB per frame)",
        out.len() as f64 / 1_048_576.0,
        out.len() as f64 / n as f64 / 1024.0
    );
}
