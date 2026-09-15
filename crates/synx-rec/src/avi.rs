//! AVI, holding motion JPEG.
//!
//! # Why this container
//!
//! It is the simplest one that every player on all three target platforms
//! opens without being told anything: Windows' own player, QuickTime, VLC,
//! mpv, ffmpeg, and every editor that has ever imported footage. MP4 would be
//! smaller on paper and is a far bigger specification to get right - boxes,
//! sample tables, a time scale, an `avcC` - and none of that buys anything for
//! a stream whose frames are already independent.
//!
//! It is also, and this is the part that matters here, APPENDABLE. A frame is
//! a chunk; the index is a list of offsets written at the end. That means the
//! recorder can decide what goes in the file after the frames exist, which is
//! exactly what stitching highlights together is.

/// Little-endian writers, because RIFF is little-endian throughout.
#[inline]
fn u32le(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}
#[inline]
fn u16le(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}
#[inline]
fn tag(out: &mut Vec<u8>, s: &[u8; 4]) {
    out.extend_from_slice(s);
}

/// Patch a four-byte size that was written as a placeholder.
#[inline]
fn patch(out: &mut [u8], at: usize, v: u32) {
    out[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

/// Build a complete MJPEG AVI from a list of already-encoded JPEG frames.
///
/// `fps` is the playback rate written into the header. The recorder paces its
/// capture to the same number, so a clip plays at the speed it happened -
/// which is the whole reason the capture is paced rather than per-frame.
pub fn mux(frames: &[&[u8]], w: u32, h: u32, fps: u32, out: &mut Vec<u8>) {
    out.clear();
    let fps = fps.max(1);
    let biggest = frames.iter().map(|f| f.len()).max().unwrap_or(0) as u32;
    let total = frames.len() as u32;

    // ---- RIFF ------------------------------------------------------------
    tag(out, b"RIFF");
    let riff_size_at = out.len();
    u32le(out, 0); // patched at the end
    tag(out, b"AVI ");

    // ---- LIST hdrl -------------------------------------------------------
    tag(out, b"LIST");
    let hdrl_size_at = out.len();
    u32le(out, 0);
    let hdrl_start = out.len();
    tag(out, b"hdrl");

    // avih: the file's own header
    tag(out, b"avih");
    u32le(out, 56);
    u32le(out, 1_000_000 / fps);        // microseconds per frame
    u32le(out, biggest * fps);          // a rough max data rate
    u32le(out, 0);                      // padding granularity
    u32le(out, 0x0000_0110);            // HASINDEX | ISINTERLEAVED
    u32le(out, total);                  // total frames
    u32le(out, 0);                      // initial frames
    u32le(out, 1);                      // one stream
    u32le(out, biggest);                // suggested buffer
    u32le(out, w);
    u32le(out, h);
    for _ in 0..4 {
        u32le(out, 0); // reserved
    }

    // ---- LIST strl -------------------------------------------------------
    tag(out, b"LIST");
    let strl_size_at = out.len();
    u32le(out, 0);
    let strl_start = out.len();
    tag(out, b"strl");

    // strh: the video stream
    tag(out, b"strh");
    u32le(out, 56);
    tag(out, b"vids");
    tag(out, b"MJPG");
    u32le(out, 0);          // flags
    u16le(out, 0);          // priority
    u16le(out, 0);          // language
    u32le(out, 0);          // initial frames
    u32le(out, 1);          // scale
    u32le(out, fps);        // rate: rate/scale = fps
    u32le(out, 0);          // start
    u32le(out, total);      // length, in frames
    u32le(out, biggest);    // suggested buffer
    u32le(out, 10_000);     // quality, in the usual 0..10000
    u32le(out, 0);          // sample size: 0 means variable
    u16le(out, 0);          // rcFrame
    u16le(out, 0);
    u16le(out, w as u16);
    u16le(out, h as u16);

    // strf: BITMAPINFOHEADER
    tag(out, b"strf");
    u32le(out, 40);
    u32le(out, 40);         // biSize
    u32le(out, w);
    u32le(out, h);
    u16le(out, 1);          // planes
    u16le(out, 24);         // bits per pixel
    tag(out, b"MJPG");      // biCompression
    u32le(out, w * h * 3);  // biSizeImage
    u32le(out, 0);          // x pixels per metre
    u32le(out, 0);          // y
    u32le(out, 0);          // colours used
    u32le(out, 0);          // colours important

    let strl_len = (out.len() - strl_start) as u32;
    patch(out, strl_size_at, strl_len);
    let hdrl_len = (out.len() - hdrl_start) as u32;
    patch(out, hdrl_size_at, hdrl_len);

    // ---- LIST movi -------------------------------------------------------
    tag(out, b"LIST");
    let movi_size_at = out.len();
    u32le(out, 0);
    let movi_start = out.len();     // the byte the 'movi' FOURCC starts at
    tag(out, b"movi");

    /* The index is built as the frames are written, because an entry is an
       offset and an offset is only known once the thing has been placed. */
    let mut index = Vec::with_capacity(frames.len() * 16);
    for f in frames {
        let here = out.len();
        tag(out, b"00dc");
        u32le(out, f.len() as u32);
        out.extend_from_slice(f);
        /* RIFF chunks are word aligned. A JPEG of odd length needs a pad byte
           that is NOT counted in the chunk's size - get this wrong and every
           chunk after the first odd one is read at the wrong offset. */
        if f.len() % 2 == 1 {
            out.push(0);
        }
        index.extend_from_slice(b"00dc");
        index.extend_from_slice(&0x10u32.to_le_bytes()); // AVIIF_KEYFRAME
        /* Relative to the 'movi' FOURCC, which is the convention every player
           in common use reads - the first frame lands at 4. */
        index.extend_from_slice(&((here - movi_start) as u32).to_le_bytes());
        index.extend_from_slice(&(f.len() as u32).to_le_bytes());
    }

    let movi_len = (out.len() - movi_start) as u32;
    patch(out, movi_size_at, movi_len);

    // ---- idx1 ------------------------------------------------------------
    tag(out, b"idx1");
    u32le(out, index.len() as u32);
    out.extend_from_slice(&index);

    let riff_len = (out.len() - riff_size_at - 4) as u32;
    patch(out, riff_size_at, riff_len);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u32(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }
    fn find(b: &[u8], what: &[u8; 4]) -> usize {
        b.windows(4).position(|w| w == what).expect("tag not present")
    }

    #[test]
    fn the_container_is_well_formed() {
        let a = vec![1u8, 2, 3, 4, 5];       // odd length, on purpose
        let b = vec![9u8; 40];
        let frames: Vec<&[u8]> = vec![&a, &b];
        let mut out = Vec::new();
        mux(&frames, 320, 240, 30, &mut out);

        assert_eq!(&out[0..4], b"RIFF");
        assert_eq!(&out[8..12], b"AVI ");
        assert_eq!(
            read_u32(&out, 4) as usize,
            out.len() - 8,
            "the RIFF size must cover everything after itself"
        );

        // the header says two frames at 30 fps
        let avih = find(&out, b"avih");
        assert_eq!(read_u32(&out, avih + 8), 1_000_000 / 30, "microseconds per frame");
        assert_eq!(read_u32(&out, avih + 24), 2, "total frames");

        // ...and so does the stream header
        let strh = find(&out, b"strh");
        assert_eq!(&out[strh + 8..strh + 12], b"vids");
        assert_eq!(&out[strh + 12..strh + 16], b"MJPG");
        assert_eq!(read_u32(&out, strh + 32), 30, "rate over scale is the frame rate");
        assert_eq!(read_u32(&out, strh + 40), 2, "stream length in frames");
    }

    #[test]
    fn every_index_entry_points_at_its_frame() {
        let a = vec![1u8, 2, 3, 4, 5];
        let b = vec![9u8; 40];
        let c = vec![7u8; 3];
        let frames: Vec<&[u8]> = vec![&a, &b, &c];
        let mut out = Vec::new();
        mux(&frames, 64, 64, 25, &mut out);

        let movi = find(&out, b"movi");
        let idx = find(&out, b"idx1");
        let n = read_u32(&out, idx + 4) as usize / 16;
        assert_eq!(n, 3, "one index entry per frame");

        for (i, want) in [&a, &b, &c].iter().enumerate() {
            let e = idx + 8 + i * 16;
            assert_eq!(&out[e..e + 4], b"00dc");
            assert_eq!(read_u32(&out, e + 4), 0x10, "every MJPEG frame is a key frame");
            let off = read_u32(&out, e + 8) as usize;
            let len = read_u32(&out, e + 12) as usize;
            let at = movi + off;
            assert_eq!(&out[at..at + 4], b"00dc", "entry {i} does not point at a chunk");
            assert_eq!(read_u32(&out, at + 4) as usize, len, "entry {i} has the wrong length");
            assert_eq!(&out[at + 8..at + 8 + len], &want[..], "entry {i} points at the wrong bytes");
        }
    }

    #[test]
    fn an_odd_frame_is_padded_without_the_pad_being_counted() {
        let odd = vec![0xABu8; 7];
        let next = vec![0xCDu8; 4];
        let frames: Vec<&[u8]> = vec![&odd, &next];
        let mut out = Vec::new();
        mux(&frames, 16, 16, 30, &mut out);

        let idx = find(&out, b"idx1");
        assert_eq!(read_u32(&out, idx + 20), 7, "the stated length excludes the pad");
        let movi = find(&out, b"movi");
        let second = movi + read_u32(&out, idx + 8 + 16 + 8) as usize;
        assert_eq!(&out[second..second + 4], b"00dc");
        assert_eq!(second % 2, 0, "chunks must start on an even byte");
    }

    #[test]
    fn no_frames_is_a_file_rather_than_a_panic() {
        let mut out = Vec::new();
        mux(&[], 320, 240, 30, &mut out);
        assert_eq!(&out[0..4], b"RIFF");
        let avih = find(&out, b"avih");
        assert_eq!(read_u32(&out, avih + 24), 0, "no frames");
    }
}
