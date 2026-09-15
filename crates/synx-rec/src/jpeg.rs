//! Baseline JPEG, written out.
//!
//! # Why an encoder and not a library
//!
//! Nothing else in this repository has a dependency, and this is not the place
//! to start: a recorder that only works when a crates.io build succeeds is a
//! recorder that stops working. Baseline JPEG is also genuinely small - a
//! forward DCT, a quantiser, and a Huffman coder over the standard tables -
//! and the whole of it is below.
//!
//! # Why JPEG at all, for VIDEO
//!
//! Because every frame has to be independent.
//!
//! The recorder keeps a ring of the last N seconds and throws the oldest frame
//! away to make room. An inter-frame codec cannot do that: frame 400 is
//! described in terms of frame 399, so dropping the front of the buffer either
//! corrupts everything after it or forces a re-encode of the whole window. A
//! codec where each frame stands alone makes the ring a plain queue, makes a
//! highlight a slice of that queue, and makes stitching two highlights
//! together a concatenation rather than a transcode.
//!
//! It costs bytes - about 12:1 rather than the 100:1 an inter-frame codec
//! manages on a static shot - and buys the entire feature for four hundred
//! lines and no dependencies. On gameplay, where the whole frame changes every
//! frame anyway, the gap is far smaller than that headline.
//!
//! # 4:2:0
//!
//! The chroma planes are half resolution in both axes, which is what every
//! video format does and what the eye is least able to see. It is 2x the
//! saving for one extra loop over the image.

use crate::bits::BitWriter;

/// The standard luminance quantisation table (ITU T.81 Annex K.1).
const QUANT_LUMA: [u8; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
];

/// ...and chrominance (Annex K.2).
const QUANT_CHROMA: [u8; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
];

/// Zig-zag order: where each of the 64 coefficients goes in the stream.
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
];

/* The standard Huffman tables (Annex K.3). They are not optimal for any
   particular image and that is the point: an encoder that builds its own
   tables has to make two passes over every frame, and the recorder is running
   inside the frame budget of a game. The difference on a photographic frame is
   a few per cent. */
const DC_LUMA_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_LUMA_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const AC_CHROMA_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];

/// One Huffman table, expanded to (code, length) per symbol for O(1) lookup.
#[derive(Clone)]
pub struct Huff {
    code: [u16; 256],
    size: [u8; 256],
}

impl Huff {
    fn build(bits: &[u8; 16], vals: &[u8]) -> Huff {
        let mut h = Huff { code: [0; 256], size: [0; 256] };
        let mut code: u16 = 0;
        let mut k = 0usize;
        for len in 1..=16u8 {
            for _ in 0..bits[(len - 1) as usize] {
                let sym = vals[k] as usize;
                h.code[sym] = code;
                h.size[sym] = len;
                code = code.wrapping_add(1);
                k += 1;
            }
            code <<= 1;
        }
        h
    }
}

/// The four tables and the two quantisers, built once per quality.
pub struct Tables {
    pub q_luma: [u16; 64],
    pub q_chroma: [u16; 64],
    dc_luma: Huff,
    ac_luma: Huff,
    dc_chroma: Huff,
    ac_chroma: Huff,
}

impl Tables {
    /// `quality` is 1..=100 in the usual sense: 50 is the table as published,
    /// above that the divisors shrink and the file grows.
    pub fn new(quality: u32) -> Tables {
        let q = quality.clamp(1, 100);
        let scale = if q < 50 { 5000 / q } else { 200 - q * 2 };
        let build = |src: &[u8; 64]| {
            let mut out = [0u16; 64];
            for i in 0..64 {
                let v = (src[i] as u32 * scale + 50) / 100;
                out[i] = v.clamp(1, 255) as u16;
            }
            out
        };
        Tables {
            q_luma: build(&QUANT_LUMA),
            q_chroma: build(&QUANT_CHROMA),
            dc_luma: Huff::build(&DC_LUMA_BITS, &DC_LUMA_VALS),
            ac_luma: Huff::build(&AC_LUMA_BITS, &AC_LUMA_VALS),
            dc_chroma: Huff::build(&DC_CHROMA_BITS, &DC_CHROMA_VALS),
            ac_chroma: Huff::build(&AC_CHROMA_BITS, &AC_CHROMA_VALS),
        }
    }
}

/* ------------------------------------------------------------------ DCT -- */

/// The separable forward DCT-II over one 8x8 block, in place.
///
/// Written plainly rather than as one of the fast integer approximations: it
/// is eight one-dimensional transforms each way, it is exact, and at 480p it
/// is not what the encoder spends its time on - the Huffman coder is.
fn fdct(block: &mut [f32; 64]) {
    // precomputed cos((2i+1) * u * PI / 16) * (u == 0 ? 1/sqrt2 : 1) * 0.5
    static COS: [[f32; 8]; 8] = build_cos();
    let mut tmp = [0f32; 64];
    // rows
    for y in 0..8 {
        for u in 0..8 {
            let mut s = 0f32;
            for x in 0..8 {
                s += block[y * 8 + x] * COS[u][x];
            }
            tmp[y * 8 + u] = s;
        }
    }
    // columns
    for x in 0..8 {
        for v in 0..8 {
            let mut s = 0f32;
            for y in 0..8 {
                s += tmp[y * 8 + x] * COS[v][y];
            }
            block[v * 8 + x] = s;
        }
    }
}

/// `cos((2x+1) u PI / 16) * c(u) * 0.5`, evaluated at compile time.
const fn build_cos() -> [[f32; 8]; 8] {
    // const fn cannot call cos(), so the table is written out. Generated with
    // the expression above and checked against it by a unit test below.
    [
        [0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338, 0.35355338],
        [0.49039263, 0.41573480, 0.27778512, 0.09754516, -0.09754516, -0.27778512, -0.41573480, -0.49039263],
        [0.46193978, 0.19134171, -0.19134171, -0.46193978, -0.46193978, -0.19134171, 0.19134171, 0.46193978],
        [0.41573480, -0.09754516, -0.49039263, -0.27778512, 0.27778512, 0.49039263, 0.09754516, -0.41573480],
        [0.35355338, -0.35355338, -0.35355338, 0.35355338, 0.35355338, -0.35355338, -0.35355338, 0.35355338],
        [0.27778512, -0.49039263, 0.09754516, 0.41573480, -0.41573480, -0.09754516, 0.49039263, -0.27778512],
        [0.19134171, -0.46193978, 0.46193978, -0.19134171, -0.19134171, 0.46193978, -0.46193978, 0.19134171],
        [0.09754516, -0.27778512, 0.41573480, -0.49039263, 0.49039263, -0.41573480, 0.27778512, -0.09754516],
    ]
}

/* --------------------------------------------------------------- writing -- */

/// How many bits a coefficient's magnitude needs, and its JPEG bit pattern.
#[inline]
fn magnitude(v: i32) -> (u8, u16) {
    let a = v.unsigned_abs();
    let mut n = 0u8;
    let mut t = a;
    while t != 0 {
        n += 1;
        t >>= 1;
    }
    // negatives are stored as the one's complement of the magnitude
    let bits = if v < 0 { (v - 1) as u16 & ((1u16 << n) - 1) } else { v as u16 };
    (n, bits)
}

/// Encode one quantised block, returning the new DC predictor.
fn write_block(
    w: &mut BitWriter,
    block: &[f32; 64],
    quant: &[u16; 64],
    dc_tab: &Huff,
    ac_tab: &Huff,
    prev_dc: i32,
) -> i32 {
    let mut zz = [0i32; 64];
    for i in 0..64 {
        let q = quant[ZIGZAG[i]] as f32;
        // round half away from zero, the way every encoder does
        let v = block[ZIGZAG[i]] / q;
        zz[i] = if v < 0.0 { -((-v) + 0.5) as i32 } else { (v + 0.5) as i32 };
    }

    // ---- DC: the difference from the previous block of the same component --
    let diff = zz[0] - prev_dc;
    let (n, bits) = magnitude(diff);
    w.huff(dc_tab.code[n as usize], dc_tab.size[n as usize]);
    if n > 0 {
        w.raw(bits, n);
    }

    // ---- AC: run-length of zeroes, then the magnitude ----------------------
    let mut run = 0u8;
    for i in 1..64 {
        if zz[i] == 0 {
            run += 1;
            continue;
        }
        while run >= 16 {
            // ZRL: sixteen zeroes and no coefficient
            w.huff(ac_tab.code[0xf0], ac_tab.size[0xf0]);
            run -= 16;
        }
        let (n, bits) = magnitude(zz[i]);
        let sym = ((run as usize) << 4) | n as usize;
        w.huff(ac_tab.code[sym], ac_tab.size[sym]);
        w.raw(bits, n);
        run = 0;
    }
    if run > 0 {
        // EOB
        w.huff(ac_tab.code[0x00], ac_tab.size[0x00]);
    }
    zz[0]
}

fn seg(out: &mut Vec<u8>, marker: u8, body: &[u8]) {
    out.push(0xff);
    out.push(marker);
    let len = (body.len() + 2) as u16;
    out.push((len >> 8) as u8);
    out.push(len as u8);
    out.extend_from_slice(body);
}

/// Encode one RGB(A) frame as a complete baseline JPEG.
///
/// `src` is `w * h * stride_px` bytes with `stride_px` of 3 or 4; an alpha
/// channel is ignored rather than composited, because the framebuffer this
/// reads is already opaque.
pub fn encode(src: &[u8], w: usize, h: usize, px: usize, t: &Tables, out: &mut Vec<u8>) {
    debug_assert!(px == 3 || px == 4);
    out.clear();
    if w == 0 || h == 0 || src.len() < w * h * px {
        return;
    }

    // ---- header -----------------------------------------------------------
    out.extend_from_slice(&[0xff, 0xd8]); // SOI
    seg(out, 0xe0, &[b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // APP0

    let mut dqt = Vec::with_capacity(65);
    dqt.push(0x00); // 8-bit, table 0
    for i in 0..64 {
        dqt.push(t.q_luma[ZIGZAG[i]] as u8);
    }
    seg(out, 0xdb, &dqt);
    dqt.clear();
    dqt.push(0x01);
    for i in 0..64 {
        dqt.push(t.q_chroma[ZIGZAG[i]] as u8);
    }
    seg(out, 0xdb, &dqt);

    // SOF0: baseline, 8-bit, three components, 4:2:0
    let sof = [
        8,
        (h >> 8) as u8, h as u8,
        (w >> 8) as u8, w as u8,
        3,
        1, 0x22, 0,   // Y,  2x2 sampling, quant table 0
        2, 0x11, 1,   // Cb, 1x1,          quant table 1
        3, 0x11, 1,   // Cr
    ];
    seg(out, 0xc0, &sof);

    let mut dht = Vec::new();
    let put_dht = |out: &mut Vec<u8>, dht: &mut Vec<u8>, id: u8, bits: &[u8; 16], vals: &[u8]| {
        dht.clear();
        dht.push(id);
        dht.extend_from_slice(bits);
        dht.extend_from_slice(vals);
        seg(out, 0xc4, dht);
    };
    put_dht(out, &mut dht, 0x00, &DC_LUMA_BITS, &DC_LUMA_VALS);
    put_dht(out, &mut dht, 0x10, &AC_LUMA_BITS, &AC_LUMA_VALS);
    put_dht(out, &mut dht, 0x01, &DC_CHROMA_BITS, &DC_CHROMA_VALS);
    put_dht(out, &mut dht, 0x11, &AC_CHROMA_BITS, &AC_CHROMA_VALS);

    // SOS
    seg(out, 0xda, &[3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    // ---- the scan ---------------------------------------------------------
    let mut bw = BitWriter::new(out);
    let (mut dc_y, mut dc_cb, mut dc_cr) = (0i32, 0i32, 0i32);

    let mcux = (w + 15) / 16;
    let mcuy = (h + 15) / 16;
    let mut yb = [0f32; 64];
    let mut cb = [0f32; 64];
    let mut cr = [0f32; 64];

    /* The sample at (x, y), clamped to the edge. A block that runs off the
       right or the bottom of a frame whose size is not a multiple of sixteen
       repeats the last real column or row - which is what stops the padding
       showing up as a hard edge in the decoded image. */
    let at = |x: usize, y: usize| -> (f32, f32, f32) {
        let xx = x.min(w - 1);
        let yy = y.min(h - 1);
        let i = (yy * w + xx) * px;
        (src[i] as f32, src[i + 1] as f32, src[i + 2] as f32)
    };

    for my in 0..mcuy {
        for mx in 0..mcux {
            let ox = mx * 16;
            let oy = my * 16;

            // four luma blocks
            for by in 0..2 {
                for bx in 0..2 {
                    for j in 0..8 {
                        for i in 0..8 {
                            let (r, g, b) = at(ox + bx * 8 + i, oy + by * 8 + j);
                            // BT.601 luma, level-shifted by -128
                            yb[j * 8 + i] = 0.299 * r + 0.587 * g + 0.114 * b - 128.0;
                        }
                    }
                    fdct(&mut yb);
                    dc_y = write_block(&mut bw, &yb, &t.q_luma, &t.dc_luma, &t.ac_luma, dc_y);
                }
            }

            /* The chroma blocks, each sample the mean of the 2x2 luma samples
               it covers. Averaging rather than point-sampling: a point sample
               of a dithered or aliased edge picks one of two colours at
               random, and on a neon road that reads as the colour crawling. */
            for j in 0..8 {
                for i in 0..8 {
                    let mut sb = 0f32;
                    let mut sr = 0f32;
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let (r, g, b) = at(ox + i * 2 + dx, oy + j * 2 + dy);
                            sb += -0.168_736 * r - 0.331_264 * g + 0.5 * b;
                            sr += 0.5 * r - 0.418_688 * g - 0.081_312 * b;
                        }
                    }
                    cb[j * 8 + i] = sb * 0.25;
                    cr[j * 8 + i] = sr * 0.25;
                }
            }
            fdct(&mut cb);
            dc_cb = write_block(&mut bw, &cb, &t.q_chroma, &t.dc_chroma, &t.ac_chroma, dc_cb);
            fdct(&mut cr);
            dc_cr = write_block(&mut bw, &cr, &t.q_chroma, &t.dc_chroma, &t.ac_chroma, dc_cr);
        }
    }

    bw.flush();
    out.extend_from_slice(&[0xff, 0xd9]); // EOI
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cosine table is written out because `const fn` cannot call `cos`.
    /// This is the check that what was written is what was meant.
    #[test]
    fn the_cosine_table_is_the_cosines() {
        let tab = build_cos();
        for u in 0..8usize {
            let c = if u == 0 { 1.0 / 2f64.sqrt() } else { 1.0 };
            for x in 0..8usize {
                let want = (((2 * x + 1) as f64) * (u as f64) * std::f64::consts::PI / 16.0).cos()
                    * c
                    * 0.5;
                let got = tab[u][x] as f64;
                assert!(
                    (want - got).abs() < 1e-6,
                    "cos[{u}][{x}] is {got}, should be {want}"
                );
            }
        }
    }

    #[test]
    fn magnitudes_round_trip() {
        for v in -2047i32..=2047 {
            if v == 0 {
                continue;
            }
            let (n, bits) = magnitude(v);
            assert!(n >= 1 && n <= 12, "{v} needs {n} bits");
            // the decoder's rule: a leading zero bit means negative
            let top = 1u16 << (n - 1);
            let back = if bits & top != 0 {
                bits as i32
            } else {
                bits as i32 - (1i32 << n) + 1
            };
            assert_eq!(back, v, "{v} encoded as {bits:b} over {n} bits");
        }
    }
}
