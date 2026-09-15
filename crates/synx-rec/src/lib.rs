//! SYNX // the recorder.
//!
//! A replay buffer and a clip writer: baseline JPEG for the frames, AVI for
//! the container, and a ring with marks on it for deciding which frames a
//! saved file should contain.
//!
//! # Why Rust, and why not C++
//!
//! Because of where it has to run. The frames exist in the WebGL framebuffer,
//! inside the webview's process - and the only native code that runs in that
//! process is the simulation core, which is a Rust `cdylib` compiled to
//! WebAssembly with a hand-written C ABI. Putting the encoder there means a
//! frame is read back once into a buffer the encoder already owns; putting it
//! in the desktop host instead would mean every single frame crossing an IPC
//! boundary, which at thirty frames a second is the whole budget.
//!
//! C++ would have to reach the same place through the same wasm target, would
//! add a second toolchain to a build that currently needs `cargo` and `node`,
//! and would have to talk to the Rust core across an FFI boundary to get at
//! anything. There is nothing it would buy.
//!
//! # What is fast about it
//!
//! The expensive things are all avoided rather than optimised:
//!
//!   NOTHING IS READ THAT WILL NOT BE KEPT. `Reel::wants` answers the pacing
//!   question before the caller does the `readPixels`, so a game running at
//!   144 frames a second against a 30 fps recorder does the readback thirty
//!   times, not a hundred and forty-four.
//!
//!   THE RING IS BYTES, NOT PIXELS. A frame is encoded once, on the way in,
//!   and everything after that - eviction, slicing, stitching - moves
//!   `Vec<u8>`s around. Holding thirty seconds of raw 854x480 would be two
//!   gigabytes; holding it as JPEG is about thirty megabytes.
//!
//!   SAVING IS A CONCATENATION. Every frame stands alone, so building a clip
//!   out of three moments forty seconds apart copies the bytes and writes an
//!   index. There is no transcode anywhere in the feature.

pub mod abi;
pub mod avi;
pub mod bits;
pub mod jpeg;
pub mod reel;

pub use reel::Reel;

#[cfg(test)]
mod roundtrip {
    //! A baseline JPEG DECODER, for the tests only.
    //!
    //! An encoder nobody has decoded is an encoder nobody has checked. The
    //! structural tests in `avi` and `bits` prove the container and the bit
    //! packing; this proves the only thing left, which is that the picture
    //! that comes out is the picture that went in.
    //!
    //! It is deliberately the smallest decoder that can read what `jpeg.rs`
    //! writes - baseline, 4:2:0, the tables we emit - because its job is to be
    //! obviously correct rather than general.

    use crate::jpeg;

    struct HuffDec {
        // (length, code) -> symbol, walked one bit at a time
        counts: [u8; 16],
        symbols: Vec<u8>,
    }

    impl HuffDec {
        fn decode(&self, br: &mut BitReader) -> u8 {
            let mut code: i32 = 0;
            let mut first: i32 = 0;
            let mut index: usize = 0;
            for len in 0..16 {
                code |= br.bit() as i32;
                let count = self.counts[len] as i32;
                if code - first < count {
                    return self.symbols[index + (code - first) as usize];
                }
                index += count as usize;
                first = (first + count) << 1;
                code <<= 1;
            }
            panic!("a code longer than sixteen bits");
        }
    }

    struct BitReader<'a> {
        d: &'a [u8],
        at: usize,
        acc: u32,
        n: u32,
    }

    impl<'a> BitReader<'a> {
        fn new(d: &'a [u8]) -> Self {
            BitReader { d, at: 0, acc: 0, n: 0 }
        }
        fn bit(&mut self) -> u32 {
            if self.n == 0 {
                let mut b = if self.at < self.d.len() { self.d[self.at] } else { 0 };
                self.at += 1;
                // un-stuff: 0xFF 0x00 in the scan is a literal 0xFF
                if b == 0xff {
                    if self.at < self.d.len() && self.d[self.at] == 0x00 {
                        self.at += 1;
                    } else {
                        b = 0;
                    }
                }
                self.acc = b as u32;
                self.n = 8;
            }
            self.n -= 1;
            (self.acc >> self.n) & 1
        }
        fn receive(&mut self, n: u8) -> i32 {
            let mut v = 0i32;
            for _ in 0..n {
                v = (v << 1) | self.bit() as i32;
            }
            v
        }
        /// The JPEG sign rule: a leading zero means the value is negative.
        fn extend(v: i32, n: u8) -> i32 {
            if n == 0 {
                return 0;
            }
            if v < (1 << (n - 1)) {
                v - (1 << n) + 1
            } else {
                v
            }
        }
    }

    const ZIGZAG: [usize; 64] = [
        0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
        20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
        58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
    ];

    fn idct(block: &mut [f32; 64]) {
        let mut tmp = [0f32; 64];
        let c = |u: usize| if u == 0 { 1.0 / 2f32.sqrt() } else { 1.0 };
        for y in 0..8 {
            for x in 0..8 {
                let mut s = 0f32;
                for u in 0..8 {
                    s += c(u)
                        * block[y * 8 + u]
                        * (((2 * x + 1) as f32) * (u as f32) * std::f32::consts::PI / 16.0).cos();
                }
                tmp[y * 8 + x] = s * 0.5;
            }
        }
        for x in 0..8 {
            for y in 0..8 {
                let mut s = 0f32;
                for v in 0..8 {
                    s += c(v)
                        * tmp[v * 8 + x]
                        * (((2 * y + 1) as f32) * (v as f32) * std::f32::consts::PI / 16.0).cos();
                }
                block[y * 8 + x] = s * 0.5;
            }
        }
    }

    /// Decode one of our own baseline 4:2:0 files back to RGB.
    fn decode(jpg: &[u8]) -> (usize, usize, Vec<u8>) {
        let mut at = 2; // skip SOI
        let mut qt: [[u16; 64]; 2] = [[0; 64]; 2];
        let mut dc: Vec<Option<HuffDec>> = vec![None, None];
        let mut ac: Vec<Option<HuffDec>> = vec![None, None];
        let (mut w, mut h) = (0usize, 0usize);

        loop {
            assert_eq!(jpg[at], 0xff, "expected a marker at {at}");
            let m = jpg[at + 1];
            at += 2;
            if m == 0xd9 {
                panic!("EOI before SOS");
            }
            let len = ((jpg[at] as usize) << 8 | jpg[at + 1] as usize) - 2;
            let body = &jpg[at + 2..at + 2 + len];
            at += 2 + len;
            match m {
                0xdb => {
                    let id = (body[0] & 0x0f) as usize;
                    for i in 0..64 {
                        qt[id][ZIGZAG[i]] = body[1 + i] as u16;
                    }
                }
                0xc0 => {
                    h = (body[1] as usize) << 8 | body[2] as usize;
                    w = (body[3] as usize) << 8 | body[4] as usize;
                    assert_eq!(body[5], 3, "three components");
                    assert_eq!(body[7], 0x22, "the luma plane is 2x2 sampled");
                }
                0xc4 => {
                    let id = (body[0] & 0x0f) as usize;
                    let is_ac = body[0] >> 4 == 1;
                    let mut counts = [0u8; 16];
                    counts.copy_from_slice(&body[1..17]);
                    let n: usize = counts.iter().map(|&c| c as usize).sum();
                    let t = HuffDec { counts, symbols: body[17..17 + n].to_vec() };
                    if is_ac {
                        ac[id] = Some(t);
                    } else {
                        dc[id] = Some(t);
                    }
                }
                0xda => break,
                _ => {}
            }
        }

        let mut br = BitReader::new(&jpg[at..]);
        let mcux = (w + 15) / 16;
        let mcuy = (h + 15) / 16;
        let mut y_plane = vec![0f32; mcux * 16 * mcuy * 16];
        let mut cb_plane = vec![0f32; mcux * 8 * mcuy * 8];
        let mut cr_plane = vec![0f32; mcux * 8 * mcuy * 8];
        let (mut pdc_y, mut pdc_cb, mut pdc_cr) = (0i32, 0i32, 0i32);

        let read_block = |br: &mut BitReader, qi: usize, di: usize, ai: usize, pred: &mut i32| {
            let mut coef = [0f32; 64];
            let s = dc[di].as_ref().unwrap().decode(br);
            let diff = BitReader::extend(br.receive(s), s);
            *pred += diff;
            coef[0] = (*pred * qt[qi][0] as i32) as f32;
            let mut k = 1;
            while k < 64 {
                let rs = ac[ai].as_ref().unwrap().decode(br);
                let r = rs >> 4;
                let s = rs & 15;
                if s == 0 {
                    if r == 15 {
                        k += 16;
                        continue;
                    }
                    break;
                }
                k += r as usize;
                if k > 63 {
                    break;
                }
                let v = BitReader::extend(br.receive(s), s);
                coef[ZIGZAG[k]] = (v * qt[qi][ZIGZAG[k]] as i32) as f32;
                k += 1;
            }
            idct(&mut coef);
            coef
        };

        for my in 0..mcuy {
            for mx in 0..mcux {
                for by in 0..2 {
                    for bx in 0..2 {
                        let b = read_block(&mut br, 0, 0, 0, &mut pdc_y);
                        for j in 0..8 {
                            for i in 0..8 {
                                let x = mx * 16 + bx * 8 + i;
                                let y = my * 16 + by * 8 + j;
                                y_plane[y * mcux * 16 + x] = b[j * 8 + i] + 128.0;
                            }
                        }
                    }
                }
                let b = read_block(&mut br, 1, 1, 1, &mut pdc_cb);
                for j in 0..8 {
                    for i in 0..8 {
                        cb_plane[(my * 8 + j) * mcux * 8 + mx * 8 + i] = b[j * 8 + i];
                    }
                }
                let b = read_block(&mut br, 1, 1, 1, &mut pdc_cr);
                for j in 0..8 {
                    for i in 0..8 {
                        cr_plane[(my * 8 + j) * mcux * 8 + mx * 8 + i] = b[j * 8 + i];
                    }
                }
            }
        }

        let mut rgb = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let yy = y_plane[y * mcux * 16 + x];
                let cb = cb_plane[(y / 2) * mcux * 8 + x / 2];
                let cr = cr_plane[(y / 2) * mcux * 8 + x / 2];
                let r = yy + 1.402 * cr;
                let g = yy - 0.344_136 * cb - 0.714_136 * cr;
                let b = yy + 1.772 * cb;
                let i = (y * w + x) * 3;
                rgb[i] = r.clamp(0.0, 255.0) as u8;
                rgb[i + 1] = g.clamp(0.0, 255.0) as u8;
                rgb[i + 2] = b.clamp(0.0, 255.0) as u8;
            }
        }
        (w, h, rgb)
    }

    /// Mean absolute error per channel between two RGB buffers.
    fn mae(a: &[u8], b: &[u8]) -> f64 {
        let mut s = 0f64;
        for i in 0..a.len() {
            s += (a[i] as f64 - b[i] as f64).abs();
        }
        s / a.len() as f64
    }

    #[test]
    fn a_flat_colour_survives_the_round_trip() {
        let (w, h) = (64, 48);
        let mut src = vec![0u8; w * h * 3];
        for i in (0..src.len()).step_by(3) {
            src[i] = 200;
            src[i + 1] = 40;
            src[i + 2] = 120;
        }
        let t = jpeg::Tables::new(90);
        let mut out = Vec::new();
        jpeg::encode(&src, w, h, 3, &t, &mut out);
        let (dw, dh, back) = decode(&out);
        assert_eq!((dw, dh), (w, h));
        assert!(mae(&src, &back) < 3.0, "a flat colour came back {} off", mae(&src, &back));
    }

    #[test]
    fn a_gradient_survives_the_round_trip() {
        let (w, h) = (96, 64);
        let mut src = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                src[i] = (x * 255 / w) as u8;
                src[i + 1] = (y * 255 / h) as u8;
                src[i + 2] = ((x + y) * 255 / (w + h)) as u8;
            }
        }
        let t = jpeg::Tables::new(92);
        let mut out = Vec::new();
        jpeg::encode(&src, w, h, 3, &t, &mut out);
        let (_, _, back) = decode(&out);
        let e = mae(&src, &back);
        assert!(e < 6.0, "a gradient came back {e} off per channel");
    }

    /// The case that catches an MCU-padding bug: a frame whose size is not a
    /// multiple of sixteen, so the last row and column of blocks run off the
    /// edge of the picture.
    #[test]
    fn an_odd_size_survives_the_round_trip() {
        let (w, h) = (70, 37);
        let mut src = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                let v = if (x / 7 + y / 5) % 2 == 0 { 210 } else { 30 };
                src[i] = v;
                src[i + 1] = v;
                src[i + 2] = v;
            }
        }
        let t = jpeg::Tables::new(95);
        let mut out = Vec::new();
        jpeg::encode(&src, w, h, 3, &t, &mut out);
        let (dw, dh, back) = decode(&out);
        assert_eq!((dw, dh), (w, h), "the frame size must survive");
        let e = mae(&src, &back);
        assert!(e < 14.0, "a hard checkerboard at an odd size came back {e} off");
    }

    /// RGBA in, with the alpha ignored rather than composited.
    #[test]
    fn an_alpha_channel_is_skipped_not_mixed_in() {
        let (w, h) = (32, 32);
        let mut rgba = vec![0u8; w * h * 4];
        let mut rgb = vec![0u8; w * h * 3];
        for p in 0..w * h {
            let (r, g, b) = ((p % 255) as u8, 90u8, 160u8);
            rgba[p * 4] = r;
            rgba[p * 4 + 1] = g;
            rgba[p * 4 + 2] = b;
            rgba[p * 4 + 3] = 7; // a nonsense alpha that must not show up
            rgb[p * 3] = r;
            rgb[p * 3 + 1] = g;
            rgb[p * 3 + 2] = b;
        }
        let t = jpeg::Tables::new(90);
        let mut a = Vec::new();
        let mut b = Vec::new();
        jpeg::encode(&rgba, w, h, 4, &t, &mut a);
        jpeg::encode(&rgb, w, h, 3, &t, &mut b);
        assert_eq!(a, b, "the alpha channel changed the encoded stream");
    }

    /// Quality has to mean something in both directions.
    #[test]
    fn higher_quality_is_bigger_and_closer() {
        let (w, h) = (64, 64);
        let mut src = vec![0u8; w * h * 3];
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                src[i] = ((x * 3 + y) % 256) as u8;
                src[i + 1] = ((y * 5) % 256) as u8;
                src[i + 2] = ((x ^ y) % 256) as u8;
            }
        }
        let mut lo = Vec::new();
        let mut hi = Vec::new();
        jpeg::encode(&src, w, h, 3, &jpeg::Tables::new(25), &mut lo);
        jpeg::encode(&src, w, h, 3, &jpeg::Tables::new(95), &mut hi);
        assert!(hi.len() > lo.len(), "quality 95 was not bigger than 25");
        let e_lo = mae(&src, &decode(&lo).2);
        let e_hi = mae(&src, &decode(&hi).2);
        assert!(e_hi < e_lo, "quality 95 ({e_hi}) was not closer than 25 ({e_lo})");
    }

    /// The whole feature, end to end: frames in, a playable file out.
    #[test]
    fn a_clip_is_a_file_with_the_frames_in_it() {
        let (w, h) = (48, 32);
        let mut r = crate::Reel::new(w, h, 20, 80, 60_000, 64 << 20);
        for i in 0..40u32 {
            let v = (i * 6) as u8;
            r.push(&vec![v; w * h * 3], 3, i * 50);
        }
        let mut out = Vec::new();
        let n = r.save_all(&mut out);
        assert_eq!(n, r.held_frames());
        assert_eq!(&out[0..4], b"RIFF");
        // every indexed chunk must itself be a JPEG
        let idx = out.windows(4).position(|x| x == b"idx1").unwrap();
        let movi = out.windows(4).position(|x| x == b"movi").unwrap();
        let count = u32::from_le_bytes([out[idx + 4], out[idx + 5], out[idx + 6], out[idx + 7]]) as usize / 16;
        assert_eq!(count, n);
        for i in 0..count {
            let e = idx + 8 + i * 16;
            let off = u32::from_le_bytes([out[e + 8], out[e + 9], out[e + 10], out[e + 11]]) as usize;
            let at = movi + off + 8;
            assert_eq!(&out[at..at + 2], &[0xff, 0xd8], "frame {i} is not a JPEG");
        }
    }
}
