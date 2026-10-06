//! The SYNX mark, on every frame the recorder keeps.
//!
//! # Why here, and not in the page
//!
//! Every clip the game can write - the last thirty seconds, the stitched
//! highlights, the automatic best moment, the whole ring - is cut from frames
//! that went through [`crate::Reel::push_scored`], and nothing else can put a
//! frame in the ring. Stamping there, on the raw pixels before they are
//! encoded, is the one place where "every recording carries the mark" is true
//! by construction rather than by every caller remembering to do it.
//!
//! The artwork itself is drawn by the page, which has the game's typefaces and
//! a 2D canvas to set them with - see `watermarkArt` in web/js/record.js - and
//! handed over premultiplied. Until it arrives, or if it never can (a page
//! with no 2D context), the mark is the block lettering drawn in
//! [`Watermark::builtin`]. A frame is never encoded without one or the other.

/// A premultiplied RGBA overlay and where it sits on the frame.
#[derive(Clone)]
pub struct Watermark {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    /// `w * h * 4`, premultiplied: colour already scaled by its own alpha, so
    /// laying it over a pixel is one multiply-add per channel.
    px: Vec<u8>,
}

/// How far in from the frame's corner the mark sits, as a fraction of its
/// height. The same margin the page uses for its own artwork.
const MARGIN: f32 = 0.035;

impl Watermark {
    /// The page's artwork, placed at (`x`, `y`) on a `fw` x `fh` frame.
    ///
    /// Refused - `None` - when it does not fit inside the frame or the buffer
    /// is not the size it claims, because a mark that would write past the
    /// frame is a mark that corrupts the encode. The caller then keeps the
    /// one it already has, which is never nothing.
    pub fn from_rgba(fw: usize, fh: usize, x: usize, y: usize, w: usize, h: usize, rgba: &[u8]) -> Option<Self> {
        if w == 0 || h == 0 || x + w > fw || y + h > fh || rgba.len() != w * h * 4 {
            return None;
        }
        // A premultiplied pixel can never be brighter than its own alpha. One
        // that is came in straight rather than premultiplied, and would be
        // laid on as a glowing box instead of as the letters.
        if rgba.chunks_exact(4).any(|p| p[0] > p[3] || p[1] > p[3] || p[2] > p[3]) {
            return None;
        }
        Some(Watermark { x, y, w, h, px: rgba.to_vec() })
    }

    /// THE FALLBACK: S Y N X in block capitals, drawn here, so the recorder
    /// stamps its frames even when the page could not draw its own artwork.
    /// White at most of full strength over a dark offset shadow - legible on
    /// a night sky and on a sunlit road alike - in the bottom-right corner,
    /// sized from the frame's height.
    pub fn builtin(fw: usize, fh: usize) -> Self {
        // 5 x 7 cells per letter, one cell between letters
        const GLYPHS: [[&str; 7]; 4] = [
            [".###.", "#...#", "#....", ".###.", "....#", "#...#", ".###."],
            ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
            ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
            ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
        ];
        let k = (fh / 120).max(1);
        let shadow = (k / 2).max(1);
        let w = (4 * 5 + 3) * k + shadow;
        let h = 7 * k + shadow;
        let mut px = vec![0u8; w * h * 4];
        let mut put = |x: usize, y: usize, v: u8, a: u8| {
            let i = (y * w + x) * 4;
            // straight colour over what is already there, premultiplied
            let a0 = px[i + 3] as u32;
            let na = a as u32 + a0 * (255 - a as u32) / 255;
            for c in 0..3 {
                let src = v as u32 * a as u32 / 255;
                px[i + c] = (src + px[i + c] as u32 * (255 - a as u32) / 255).min(na) as u8;
            }
            px[i + 3] = na as u8;
        };
        // the shadow first, then the letters over it
        for (off, v, a) in [(shadow, 0u8, 150u8), (0, 255u8, 225u8)] {
            for (gi, g) in GLYPHS.iter().enumerate() {
                for (row, line) in g.iter().enumerate() {
                    for (col, ch) in line.bytes().enumerate() {
                        if ch != b'#' {
                            continue;
                        }
                        let cx = (gi * 6 + col) * k + off;
                        let cy = row * k + off;
                        for yy in cy..cy + k {
                            for xx in cx..cx + k {
                                if xx < w && yy < h {
                                    put(xx, yy, v, a);
                                }
                            }
                        }
                    }
                }
            }
        }
        let m = ((fh as f32) * MARGIN).round() as usize;
        let w = w.min(fw);
        let h = h.min(fh);
        Watermark {
            x: fw.saturating_sub(w + m),
            y: fh.saturating_sub(h + m),
            w,
            h,
            px: if w * h * 4 == px.len() { px } else { vec![0u8; w * h * 4] },
        }
    }

    /// Lay the mark over a `fw`-wide frame of `bpp` bytes per pixel (3 or 4),
    /// top row first. Source-over, in place: `dst = src + dst * (1 - a)`.
    pub fn apply(&self, frame: &mut [u8], fw: usize, bpp: usize) {
        if self.w == 0 || self.h == 0 {
            return;
        }
        for row in 0..self.h {
            let fy = self.y + row;
            let src = &self.px[row * self.w * 4..(row + 1) * self.w * 4];
            let start = (fy * fw + self.x) * bpp;
            let end = start + self.w * bpp;
            if end > frame.len() {
                return;
            }
            let dst = &mut frame[start..end];
            for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(bpp)) {
                let a = s[3] as u32;
                if a == 0 {
                    continue;
                }
                let inv = 255 - a;
                for c in 0..3 {
                    d[c] = (s[c] as u32 + (d[c] as u32 * inv + 127) / 255).min(255) as u8;
                }
            }
        }
    }

    /// The rectangle it covers, `(x, y, w, h)`.
    pub fn rect(&self) -> (usize, usize, usize, usize) {
        (self.x, self.y, self.w, self.h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_sits_inside_the_bottom_right_corner() {
        for (fw, fh) in [(854, 480), (1280, 720), (160, 90), (16, 16)] {
            let m = Watermark::builtin(fw, fh);
            let (x, y, w, h) = m.rect();
            assert!(x + w <= fw && y + h <= fh, "{fw}x{fh}: the mark runs off the frame");
            if fw >= 160 {
                assert!(x > fw / 2 && y > fh / 2, "{fw}x{fh}: not in the bottom-right corner");
            }
        }
    }

    #[test]
    fn the_fallback_actually_draws_letters() {
        let fw = 854;
        let fh = 480;
        let m = Watermark::builtin(fw, fh);
        let mut f = vec![0u8; fw * fh * 3];
        m.apply(&mut f, fw, 3);
        let (x, y, w, h) = m.rect();
        let lit = (y..y + h)
            .flat_map(|yy| (x..x + w).map(move |xx| (yy, xx)))
            .filter(|&(yy, xx)| f[(yy * fw + xx) * 3] > 180)
            .count();
        // a quarter to two thirds of the box is ink - letters, not a blank and not a slab
        assert!(lit * 4 > w * h / 2 && lit * 3 < w * h * 2, "{lit} lit of {}", w * h);
        // and nothing outside the box was touched
        assert!(f[..(y * fw) * 3].iter().all(|&v| v == 0));
    }

    #[test]
    fn page_artwork_is_laid_on_premultiplied() {
        // one pixel, half-transparent white, over mid grey
        let m = Watermark::from_rgba(4, 4, 1, 1, 1, 1, &[128, 128, 128, 128]).unwrap();
        let mut f = vec![100u8; 4 * 4 * 4];
        m.apply(&mut f, 4, 4);
        let i = (4 + 1) * 4;
        // 128 + 100 * 127 / 255 = 128 + 50
        assert_eq!(&f[i..i + 3], &[178, 178, 178]);
        assert_eq!(f[i + 3], 100, "the frame's own alpha byte is left alone");
        assert_eq!(f[0], 100, "a pixel outside the mark moved");
    }

    #[test]
    fn artwork_that_does_not_fit_or_is_not_premultiplied_is_refused() {
        assert!(Watermark::from_rgba(10, 10, 8, 0, 4, 1, &[0; 16]).is_none(), "off the right edge");
        assert!(Watermark::from_rgba(10, 10, 0, 0, 2, 2, &[0; 12]).is_none(), "short buffer");
        assert!(Watermark::from_rgba(10, 10, 0, 0, 1, 1, &[255, 255, 255, 10]).is_none(), "straight alpha");
        assert!(Watermark::from_rgba(10, 10, 0, 0, 0, 0, &[]).is_none(), "empty");
        assert!(Watermark::from_rgba(10, 10, 2, 3, 1, 1, &[10, 20, 30, 40]).is_some());
    }
}
