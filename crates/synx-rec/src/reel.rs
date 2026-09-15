//! The replay buffer, and what "the best parts" means.
//!
//! # The shape of it
//!
//! Recording is always a RING. Frames go in at one end and fall out of the
//! other once the buffer is over its budget, so the cost of leaving it on is
//! fixed no matter how long the session runs - which is the difference between
//! a feature a player leaves enabled and one they turn on for a lap and forget
//! about.
//!
//! On top of that there are MARKS. The game calls `mark` when something
//! happened worth keeping - a clean landing, an overtake, a win, a save from a
//! spin - and a mark claims a window of the ring either side of itself. Saving
//! a reel merges the overlapping windows and writes them out in order, so
//! three highlights forty seconds apart come out as one file with three
//! moments in it and none of the driving in between.
//!
//! # Why the buffer is bounded in BOTH bytes and time
//!
//! Either one alone lies. A byte budget alone means a clip whose length
//! depends on how busy the picture was, so the same key gives you eighteen
//! seconds on an empty road and six in a tunnel full of neon. A time budget
//! alone means the memory a player has given up is unbounded. Both together
//! mean the buffer holds "the last thirty seconds, unless that would cost more
//! than the budget, in which case the oldest goes" - which is honest in the
//! only two units anybody cares about.

use crate::avi;
use crate::jpeg;

pub struct Frame {
    pub t_ms: u32,
    pub bytes: Vec<u8>,
    /// HOW INTERESTING THIS FRAME WAS, 0..1000, decided by the caller from
    /// what the game knew at the time it was drawn - speed, air, how close
    /// the nearest car was, what had just been hit. It is carried per frame
    /// rather than summarised per second because `save_best` reads every one
    /// of them: that is the automatic mode, and averaging first would blunt
    /// exactly the spikes it is looking for.
    pub score: u16,
}

pub struct Mark {
    pub t_ms: u32,
    /// A short tag for the moment, kept so the saved file can be named after
    /// what is in it rather than after the clock.
    pub label: [u8; 24],
    pub label_len: u8,
}

impl Mark {
    pub fn text(&self) -> &str {
        core::str::from_utf8(&self.label[..self.label_len as usize]).unwrap_or("")
    }
}

pub struct Reel {
    pub w: usize,
    pub h: usize,
    pub fps: u32,
    /// How far either side of a mark is kept. Before is longer than after
    /// because the thing that makes a moment readable is the approach to it.
    pub pre_ms: u32,
    pub post_ms: u32,
    pub window_ms: u32,
    pub budget: usize,

    frames: std::collections::VecDeque<Frame>,
    marks: Vec<Mark>,
    bytes: usize,
    tables: jpeg::Tables,
    scratch: Vec<u8>,
    /// Frames offered and frames actually taken, for the readout.
    pub offered: u64,
    pub taken: u64,
    last_ms: u32,
}

impl Reel {
    pub fn new(w: usize, h: usize, fps: u32, quality: u32, window_ms: u32, budget: usize) -> Reel {
        Reel {
            w,
            h,
            fps: fps.max(1),
            pre_ms: 9_000,
            post_ms: 3_000,
            window_ms: window_ms.max(1_000),
            budget: budget.max(1 << 20),
            frames: std::collections::VecDeque::new(),
            marks: Vec::new(),
            bytes: 0,
            tables: jpeg::Tables::new(quality),
            scratch: Vec::with_capacity(1 << 17),
            offered: 0,
            taken: 0,
            last_ms: 0,
        }
    }

    pub fn held_frames(&self) -> usize {
        self.frames.len()
    }
    pub fn held_bytes(&self) -> usize {
        self.bytes
    }
    pub fn mark_count(&self) -> usize {
        self.marks.len()
    }

    /// The span the ring currently covers, in milliseconds.
    pub fn span_ms(&self) -> u32 {
        match (self.frames.front(), self.frames.back()) {
            (Some(a), Some(b)) => b.t_ms.saturating_sub(a.t_ms),
            _ => 0,
        }
    }

    /// Would a frame at `t_ms` be kept? The caller asks BEFORE reading the
    /// framebuffer back, because the readback is the expensive half and a
    /// frame that is going to be dropped for pacing should never be read.
    pub fn wants(&self, t_ms: u32) -> bool {
        if self.frames.is_empty() {
            return true;
        }
        let step = 1000 / self.fps;
        t_ms.saturating_sub(self.last_ms) + 1 >= step
    }

    /// Encode one frame and put it in the ring.
    ///
    /// `src` is `w * h * px` bytes, top row first. Returns the encoded size,
    /// or zero when the frame was declined.
    pub fn push(&mut self, src: &[u8], px: usize, t_ms: u32) -> usize {
        self.push_scored(src, px, t_ms, 0)
    }

    /// The same, carrying the caller's opinion of the frame. See `Frame::score`
    /// and `save_best`.
    pub fn push_scored(&mut self, src: &[u8], px: usize, t_ms: u32, score: u16) -> usize {
        self.offered += 1;
        if !self.wants(t_ms) {
            return 0;
        }
        if src.len() < self.w * self.h * px {
            return 0;
        }
        jpeg::encode(src, self.w, self.h, px, &self.tables, &mut self.scratch);
        if self.scratch.is_empty() {
            return 0;
        }
        let n = self.scratch.len();
        self.bytes += n;
        self.frames.push_back(Frame { t_ms, bytes: core::mem::take(&mut self.scratch), score });
        self.scratch = Vec::with_capacity(n + n / 4);
        self.last_ms = t_ms;
        self.taken += 1;
        self.trim(t_ms);
        n
    }

    /// Drop from the front until the ring is inside both budgets.
    ///
    /// A mark whose window has fallen out of the ring goes with it: keeping it
    /// would put an empty stretch in the saved reel, which reads as the file
    /// being broken rather than as the moment having expired.
    fn trim(&mut self, now: u32) {
        while let Some(f) = self.frames.front() {
            let too_old = now.saturating_sub(f.t_ms) > self.window_ms;
            let too_big = self.bytes > self.budget;
            if !(too_old || too_big) {
                break;
            }
            self.bytes -= f.bytes.len();
            self.frames.pop_front();
        }
        /* `post` is copied out first: retain borrows `self.marks` mutably and
           a closure that reaches back into `self` for it borrows the whole
           thing again. */
        let post = self.post_ms;
        if let Some(oldest) = self.frames.front().map(|f| f.t_ms) {
            self.marks.retain(|m| m.t_ms + post >= oldest);
        } else {
            self.marks.clear();
        }
    }

    /// Note that something worth keeping just happened.
    ///
    /// Two marks closer together than a second are one moment, not two - a
    /// clean landing that is also an overtake should claim one window rather
    /// than two overlapping ones with two names.
    pub fn mark(&mut self, t_ms: u32, label: &str) {
        if let Some(last) = self.marks.last() {
            if t_ms.saturating_sub(last.t_ms) < 1_000 {
                return;
            }
        }
        let mut m = Mark { t_ms, label: [0; 24], label_len: 0 };
        let b = label.as_bytes();
        let n = b.len().min(24);
        m.label[..n].copy_from_slice(&b[..n]);
        m.label_len = n as u8;
        self.marks.push(m);
    }

    /// The name the next save should carry: the most recent mark, or nothing.
    pub fn last_mark(&self) -> &str {
        self.marks.last().map(|m| m.text()).unwrap_or("")
    }

    pub fn clear(&mut self) {
        self.frames.clear();
        self.marks.clear();
        self.bytes = 0;
    }

    /// Everything still in the ring, as one clip.
    pub fn save_all(&self, out: &mut Vec<u8>) -> usize {
        let refs: Vec<&[u8]> = self.frames.iter().map(|f| f.bytes.as_slice()).collect();
        avi::mux(&refs, self.w as u32, self.h as u32, self.fps, out);
        refs.len()
    }

    /// The last `ms` of the ring, as one clip. This is the instant replay.
    pub fn save_last(&self, ms: u32, out: &mut Vec<u8>) -> usize {
        let end = self.frames.back().map(|f| f.t_ms).unwrap_or(0);
        let from = end.saturating_sub(ms);
        let refs: Vec<&[u8]> = self
            .frames
            .iter()
            .filter(|f| f.t_ms >= from)
            .map(|f| f.bytes.as_slice())
            .collect();
        avi::mux(&refs, self.w as u32, self.h as u32, self.fps, out);
        refs.len()
    }

    /// THE AUTOMATIC MODE: the best `span_ms` of everything still held.
    ///
    /// Every retained frame carries a score, and this reads all of them. Each
    /// frame is tried as the START of a window, the scores inside that window
    /// are summed, and the window with the largest sum wins. Two pointers, so
    /// it is one pass over the ring however long the ring is.
    ///
    /// The sum rather than the peak, deliberately. A peak picks the single
    /// loudest frame, which in this game is a collision - one frame at a
    /// thousand surrounded by nothing is a clip of a car stopping. A sum over
    /// the window picks the stretch that was interesting for the longest,
    /// which is the overtake that led to the collision, and that is the thing
    /// worth keeping.
    ///
    /// # ...and then the cut is moved so the moment is not the first frame
    ///
    /// The window that scores highest is the interesting STRETCH, which is the
    /// right thing to search for. It is the wrong thing to cut on: its first
    /// frame is wherever the sum happened to peak, so the clip opens on the
    /// landing and then plays three seconds of driving away from it.
    ///
    /// So the search picks the stretch, the loudest single frame INSIDE that
    /// stretch is taken as the moment, and the cut is laid around that frame
    /// the same way a mark's window is - mostly before it. The approach is
    /// what makes a moment readable; see `pre_ms`.
    ///
    /// Returns the number of frames written and the label to name the file
    /// after: the strongest mark that falls inside the chosen window, or
    /// nothing, in which case the caller names it itself.
    pub fn save_best(&self, span_ms: u32, out: &mut Vec<u8>) -> (usize, &str) {
        if self.frames.is_empty() {
            avi::mux(&[], self.w as u32, self.h as u32, self.fps, out);
            return (0, "");
        }
        let f: Vec<&Frame> = self.frames.iter().collect();
        let span = span_ms.max(1_000);
        /* 1. THE STRETCH. Two pointers, one pass, whatever the ring holds.
              There is no correction for a window that runs off the end of the
              ring and there does not need to be: scores are never negative, so
              for any short window at the tail there is a longer one starting
              earlier that contains every frame of it and scores at least as
              much. The search cannot return a stub while there is data. */
        let (mut peak_at, mut best) = (f[0].t_ms, -1i64);
        let mut sum = 0i64;
        let mut j = 0usize;
        for i in 0..f.len() {
            while j < f.len() && f[j].t_ms.saturating_sub(f[i].t_ms) <= span {
                sum += f[j].score as i64;
                j += 1;
            }
            if sum > best {
                best = sum;
                // 2. THE MOMENT: the loudest frame inside the winning stretch.
                peak_at = f[i..j]
                    .iter()
                    .max_by_key(|x| x.score)
                    .map(|x| x.t_ms)
                    .unwrap_or(f[i].t_ms);
            }
            sum -= f[i].score as i64;
            if j <= i + 1 && j < f.len() {
                j = i + 1;
                sum = 0;
            }
        }
        // 3. THE CUT, laid around the moment rather than starting on it.
        let lead = span * 7 / 10;
        let a = peak_at.saturating_sub(lead);
        let b = a.saturating_add(span);
        let refs: Vec<&[u8]> = f
            .iter()
            .filter(|x| x.t_ms >= a && x.t_ms <= b)
            .map(|x| x.bytes.as_slice())
            .collect();
        let n = refs.len();
        avi::mux(&refs, self.w as u32, self.h as u32, self.fps, out);
        /* Name it after the loudest thing that happened inside it. The marks
           are already the game's own vocabulary for what is worth keeping, so
           a window that contains one is a window that has a name. */
        let label = self
            .marks
            .iter()
            .filter(|m| m.t_ms >= a && m.t_ms <= b)
            .last()
            .map(|m| m.text())
            .unwrap_or("");
        (n, label)
    }

    /// Every marked moment, merged and stitched in order.
    ///
    /// Returns the number of frames written. Zero marks means zero frames
    /// rather than the whole buffer: "save the highlights" and "save
    /// everything" are different requests and the caller picks.
    pub fn save_reel(&self, out: &mut Vec<u8>) -> usize {
        if self.marks.is_empty() {
            avi::mux(&[], self.w as u32, self.h as u32, self.fps, out);
            return 0;
        }
        // the windows, in order, merged where they touch
        let mut spans: Vec<(u32, u32)> = Vec::with_capacity(self.marks.len());
        for m in &self.marks {
            let a = m.t_ms.saturating_sub(self.pre_ms);
            let b = m.t_ms.saturating_add(self.post_ms);
            match spans.last_mut() {
                Some(last) if a <= last.1 => {
                    if b > last.1 {
                        last.1 = b;
                    }
                }
                _ => spans.push((a, b)),
            }
        }
        let mut refs: Vec<&[u8]> = Vec::new();
        for f in &self.frames {
            if spans.iter().any(|&(a, b)| f.t_ms >= a && f.t_ms <= b) {
                refs.push(f.bytes.as_slice());
            }
        }
        avi::mux(&refs, self.w as u32, self.h as u32, self.fps, out);
        refs.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A flat colour frame, which encodes small and predictably.
    fn frame(w: usize, h: usize, v: u8) -> Vec<u8> {
        vec![v; w * h * 3]
    }

    /// How many frames are in a muxed clip, read back out of the AVI's own
    /// header rather than trusted from the return value.
    fn muxed_frames(out: &[u8]) -> u32 {
        let i = out.windows(4).position(|w| w == b"avih").expect("no avih") + 8;
        u32::from_le_bytes([out[i + 16], out[i + 17], out[i + 18], out[i + 19]])
    }

    /// Build a ring whose scores are `f(t_ms)`, at 20 fps.
    fn scored(len: u32, f: impl Fn(u32) -> u16) -> Reel {
        let (w, h) = (32, 32);
        let mut r = Reel::new(w, h, 20, 60, 600_000, 64 << 20);
        for i in 0..len {
            let t = i * 50;
            r.push_scored(&frame(w, h, (i % 255) as u8), 3, t, f(t));
        }
        r
    }

    #[test]
    fn the_automatic_mode_finds_the_interesting_stretch() {
        /* Twenty seconds. Dull throughout, except for two seconds at 8..10 s
           where the game was scoring hard. */
        let mut r = scored(400, |t| if (8_000..10_000).contains(&t) { 600 } else { 20 });
        r.mark(9_000, "OVERTAKE");
        let mut out = Vec::new();
        let (n, label) = r.save_best(4_000, &mut out);
        assert!(n > 0, "the automatic mode wrote nothing");
        assert_eq!(n as u32, muxed_frames(&out), "the header disagrees with the mux");
        assert_eq!(label, "OVERTAKE", "it did not name the window after what is in it");
        // four seconds at 20 fps, not the whole twenty
        assert!((75..=85).contains(&n), "cut {n} frames for four seconds at 20 fps");
    }

    #[test]
    fn one_loud_frame_does_not_out_vote_a_whole_good_stretch() {
        /* THE COLLISION PROBLEM. One frame at the ceiling is a car hitting a
           wall; two seconds at half that is the overtake that led to it. A
           peak-picker takes the first and produces a clip of a car stopping,
           which is why the search sums a window instead. */
        let r = scored(400, |t| {
            if t == 17_000 { 1000 } else if (8_000..10_000).contains(&t) { 400 } else { 5 }
        });
        let mut out = Vec::new();
        let (n, _) = r.save_best(4_000, &mut out);
        assert!(
            (75..=85).contains(&n),
            "cut {n} frames - a four-second window at 20 fps is about eighty"
        );
        /* WHERE it landed, not how long it is. Both answers are eighty frames
           long; only one of them is the right eighty. A peak-picker opens
           around fourteen seconds, chasing the one loud frame at seventeen. */
        let opened = opens_on(&r, &out);
        assert!(
            opened < 10_000,
            "the clip opens at {opened} ms - it went after the spike at 17 s instead of the \
             stretch at 8 s"
        );
        // ...and taking the spike away must not move it
        let plain = scored(400, |t| if (8_000..10_000).contains(&t) { 400 } else { 5 });
        let mut out2 = Vec::new();
        let (n2, _) = plain.save_best(4_000, &mut out2);
        assert_eq!(n, n2, "the single loud frame changed how much was cut");
        assert_eq!(
            opened,
            opens_on(&plain, &out2),
            "the single loud frame changed which stretch was chosen"
        );
    }

    /// Which frame of the ring the clip OPENS on, found by matching the first
    /// `00dc` chunk's bytes against the ring. Asking the file rather than
    /// recomputing the arithmetic the code under test just did is the whole
    /// difference between a test and a restatement.
    fn opens_on(r: &Reel, out: &[u8]) -> u32 {
        let movi = out.windows(4).position(|w| w == b"movi").expect("no movi") + 4;
        assert_eq!(&out[movi..movi + 4], b"00dc", "movi does not start with a frame");
        let len = u32::from_le_bytes([out[movi + 4], out[movi + 5], out[movi + 6], out[movi + 7]])
            as usize;
        let first = &out[movi + 8..movi + 8 + len];
        r.frames
            .iter()
            .find(|f| f.bytes == first)
            .map(|f| f.t_ms)
            .expect("the clip opens on a frame that is not in the ring")
    }

    #[test]
    fn the_cut_keeps_the_approach_rather_than_starting_on_the_moment() {
        /* A single clear peak at ten seconds, on an otherwise flat thirty.
           The clip has to CONTAIN the peak and open WELL BEFORE it: a
           highlight that opens on the landing is not a highlight, it is the
           aftermath. */
        let r = scored(600, |t| if t == 10_000 { 900 } else { 10 });
        let mut out = Vec::new();
        let (n, _) = r.save_best(4_000, &mut out);
        assert!(n > 0);
        let opened = opens_on(&r, &out);
        assert!(opened < 10_000, "the clip opens at {opened} ms, on or after the moment");
        assert!(
            10_000 - opened >= 2_500,
            "the clip opens {} ms before the moment; a four-second cut owes it more approach \
             than that",
            10_000 - opened
        );
        // ...and the moment itself is still in the file
        let last = opened + (n as u32 - 1) * 50;
        assert!(last >= 10_000, "the cut ends at {last} ms and never reaches the moment");
    }

    #[test]
    fn the_automatic_mode_never_cuts_a_stub_off_the_end_of_a_run() {
        /* The run ENDS on the highest scores it ever saw. Scores are never
           negative, so a window starting earlier contains every frame of the
           tail and scores at least as much - the search cannot answer with
           the last half second. */
        let r = scored(200, |t| if t >= 9_200 { 1000 } else { 10 });
        let mut out = Vec::new();
        let (n, _) = r.save_best(4_000, &mut out);
        /* The moment is the last frame of the run, so the cut CANNOT be a
           full four seconds - there is no footage after it, and inventing
           some is not on the table. What it must not be is the tail on its
           own: the whole approach is in the ring and all of it belongs in
           the clip. Starting the window on the peak would give sixteen. */
        assert!(n >= 50, "the automatic mode cut a {n}-frame stub off the end of the run");
        assert_eq!(n as u32, muxed_frames(&out));
    }

    #[test]
    fn the_automatic_mode_on_an_empty_ring_writes_a_valid_empty_file() {
        let r = Reel::new(32, 32, 30, 60, 10_000, 1 << 20);
        let mut out = Vec::new();
        let (n, label) = r.save_best(2_000, &mut out);
        assert_eq!(n, 0);
        assert_eq!(label, "");
        assert_eq!(&out[0..4], b"RIFF", "an empty save is still a RIFF file");
        assert_eq!(muxed_frames(&out), 0);
    }

    #[test]
    fn the_ring_holds_its_window_and_no_more() {
        let (w, h) = (32, 32);
        let mut r = Reel::new(w, h, 30, 60, 1_000, 64 << 20);
        for i in 0..200u32 {
            r.push(&frame(w, h, (i % 255) as u8), 3, i * 33);
        }
        assert!(r.held_frames() > 0);
        assert!(
            r.span_ms() <= 1_000 + 33,
            "the ring kept {} ms of a 1000 ms window",
            r.span_ms()
        );
    }

    #[test]
    fn the_byte_budget_is_obeyed_too() {
        let (w, h) = (64, 64);
        // a budget of one megabyte, and a window long enough not to be the limit
        let mut r = Reel::new(w, h, 60, 90, 600_000, 1 << 20);
        for i in 0..400u32 {
            r.push(&frame(w, h, (i * 7 % 255) as u8), 3, i * 16);
        }
        assert!(
            r.held_bytes() <= (1 << 20) + 200_000,
            "held {} bytes against a 1 MB budget",
            r.held_bytes()
        );
    }

    #[test]
    fn pacing_declines_frames_that_arrive_too_soon() {
        let (w, h) = (16, 16);
        let mut r = Reel::new(w, h, 10, 60, 60_000, 64 << 20);
        // offered at 100 Hz against a 10 fps target
        for i in 0..100u32 {
            r.push(&frame(w, h, 128), 3, i * 10);
        }
        assert_eq!(r.offered, 100);
        assert!(r.taken <= 12, "took {} of 100 frames at a tenth the rate", r.taken);
        assert!(r.taken >= 9, "took only {}", r.taken);
    }

    #[test]
    fn a_reel_is_the_marked_windows_and_nothing_else() {
        let (w, h) = (16, 16);
        let mut r = Reel::new(w, h, 20, 60, 600_000, 64 << 20);
        r.pre_ms = 500;
        r.post_ms = 500;
        for i in 0..200u32 {
            r.push(&frame(w, h, 90), 3, i * 50); // 0..10_000 ms
        }
        r.mark(2_000, "ONE");
        r.mark(8_000, "TWO");
        let mut out = Vec::new();
        let n = r.save_reel(&mut out);
        // two one-second windows at 20 fps is about forty frames
        assert!(n >= 30 && n <= 50, "a two-mark reel came to {n} frames");
        assert!(n < r.held_frames(), "the reel is not supposed to be the whole buffer");
    }

    #[test]
    fn overlapping_marks_become_one_window() {
        let (w, h) = (16, 16);
        let mut r = Reel::new(w, h, 20, 60, 600_000, 64 << 20);
        r.pre_ms = 2_000;
        r.post_ms = 2_000;
        for i in 0..200u32 {
            r.push(&frame(w, h, 90), 3, i * 50);
        }
        r.mark(4_000, "A");
        r.mark(5_500, "B");
        let mut out = Vec::new();
        let n = r.save_reel(&mut out);
        // 2000..7500 is 5.5 s at 20 fps, not two separate 4 s windows
        assert!(n >= 100 && n <= 125, "the merged window came to {n} frames");
    }

    #[test]
    fn two_marks_in_the_same_moment_are_one_mark() {
        let mut r = Reel::new(16, 16, 20, 60, 600_000, 64 << 20);
        r.mark(1_000, "CLEAN LANDING");
        r.mark(1_200, "OVERTAKE");
        assert_eq!(r.mark_count(), 1, "two tags on one moment are one mark");
    }

    #[test]
    fn no_marks_is_an_empty_reel_not_the_whole_buffer() {
        let (w, h) = (16, 16);
        let mut r = Reel::new(w, h, 20, 60, 600_000, 64 << 20);
        for i in 0..40u32 {
            r.push(&frame(w, h, 20), 3, i * 50);
        }
        let mut out = Vec::new();
        assert_eq!(r.save_reel(&mut out), 0);
        assert_eq!(&out[0..4], b"RIFF", "an empty reel is still a valid file");
    }

    #[test]
    fn the_last_seconds_are_the_last_seconds() {
        let (w, h) = (16, 16);
        let mut r = Reel::new(w, h, 20, 60, 600_000, 64 << 20);
        for i in 0..200u32 {
            r.push(&frame(w, h, 20), 3, i * 50);
        }
        let mut out = Vec::new();
        let n = r.save_last(2_000, &mut out);
        assert!(n >= 38 && n <= 44, "two seconds at 20 fps came to {n} frames");
    }

    #[test]
    fn a_frame_shorter_than_the_picture_is_refused() {
        let mut r = Reel::new(64, 64, 30, 60, 60_000, 1 << 20);
        assert_eq!(r.push(&[0u8; 16], 3, 0), 0, "a short buffer must not be read past");
        assert_eq!(r.held_frames(), 0);
    }
}
