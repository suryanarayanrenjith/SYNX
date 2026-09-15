//! The bit writer the JPEG scan is built with.
//!
//! One thing about it is not obvious and is the single easiest way to produce
//! a file that half the decoders in the world reject: inside the entropy-coded
//! segment, a `0xFF` byte must be followed by a `0x00`. Every marker in JPEG
//! starts `0xFF`, so a coefficient run that happens to produce that byte would
//! otherwise look like the start of one. The stuffing is done here rather than
//! by the caller, because the caller is thinking about coefficients.

pub struct BitWriter<'a> {
    out: &'a mut Vec<u8>,
    acc: u32,
    n: u32,
}

impl<'a> BitWriter<'a> {
    pub fn new(out: &'a mut Vec<u8>) -> BitWriter<'a> {
        BitWriter { out, acc: 0, n: 0 }
    }

    #[inline]
    fn push(&mut self, byte: u8) {
        self.out.push(byte);
        if byte == 0xff {
            self.out.push(0x00);
        }
    }

    /// Write `len` bits of `bits`, most significant first.
    #[inline]
    pub fn raw(&mut self, bits: u16, len: u8) {
        if len == 0 {
            return;
        }
        let len = len as u32;
        let masked = (bits as u32) & ((1u32 << len) - 1);
        self.acc = (self.acc << len) | masked;
        self.n += len;
        while self.n >= 8 {
            self.n -= 8;
            let byte = ((self.acc >> self.n) & 0xff) as u8;
            self.push(byte);
        }
    }

    /// A Huffman code, which is the same thing with a clearer name at the call
    /// site. A zero length means the symbol was never given a code, which is a
    /// table bug rather than a stream that should silently lose a coefficient.
    #[inline]
    pub fn huff(&mut self, code: u16, len: u8) {
        debug_assert!(len > 0, "a symbol was written with no Huffman code");
        self.raw(code, len);
    }

    /// Pad to a byte boundary with ONE bits.
    ///
    /// Ones rather than zeroes, and it matters: the padding sits where a
    /// decoder may still try to read one more Huffman symbol, and a run of
    /// ones is not a prefix of any code in the standard tables, so it
    /// terminates. A run of zeroes is a valid short code in several of them.
    pub fn flush(&mut self) {
        if self.n > 0 {
            let pad = 8 - self.n;
            self.raw(0xffff, pad as u8);
        }
        self.acc = 0;
        self.n = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_come_out_most_significant_first() {
        let mut v = Vec::new();
        {
            let mut w = BitWriter::new(&mut v);
            w.raw(0b101, 3);
            w.raw(0b01010, 5);
            w.flush();
        }
        assert_eq!(v, vec![0b10101010]);
    }

    #[test]
    fn an_ff_byte_is_stuffed() {
        let mut v = Vec::new();
        {
            let mut w = BitWriter::new(&mut v);
            w.raw(0xff, 8);
            w.flush();
        }
        assert_eq!(v, vec![0xff, 0x00], "0xFF in the scan must be followed by 0x00");
    }

    #[test]
    fn the_tail_is_padded_with_ones() {
        let mut v = Vec::new();
        {
            let mut w = BitWriter::new(&mut v);
            w.raw(0b1, 1);
            w.flush();
        }
        assert_eq!(v, vec![0b1111_1111, 0x00], "padding must be ones, and then stuffed");
    }
}
