//! Ting's encodings: integers little-endian, `Bytes(x) = u32(len(x)) ‖ x`
//! (Ting wiki: data/encoding).
use crate::host::fail;
use alloc::vec::Vec;

/// `Bytes(x)`: `x` with its length in front.
pub fn framed(bytes: &[u8]) -> Vec<u8> {
    [&(bytes.len() as u32).to_le_bytes()[..], bytes].concat()
}

/// Reads an encoding exactly: anything missing reverts with the reader's
/// error, and [`Reader::end`] reverts unless everything was read.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    error: &'static [u8],
}

impl<'a> Reader<'a> {
    /// A reader that reverts with `error` on anything it cannot read.
    pub fn new(bytes: &'a [u8], error: &'static [u8]) -> Self {
        Self {
            bytes,
            at: 0,
            error,
        }
    }

    /// How many bytes were read so far.
    pub fn position(&self) -> usize {
        self.at
    }

    /// What is left to read.
    pub fn rest(&self) -> &'a [u8] {
        &self.bytes[self.at..]
    }

    pub fn take(&mut self, n: usize) -> &'a [u8] {
        if n > self.bytes.len() - self.at {
            fail(self.error);
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        out
    }

    pub fn array<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N));
        out
    }

    /// A 32-byte id: a ContractId, an account, a hash.
    pub fn id(&mut self) -> [u8; 32] {
        self.array()
    }

    pub fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }

    pub fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.array())
    }

    pub fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.array())
    }

    pub fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.array())
    }

    pub fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.array())
    }

    /// `Bytes(x)`: a u32 length and that many bytes.
    pub fn bytes(&mut self) -> &'a [u8] {
        let len = self.u32() as usize;
        self.take(len)
    }

    /// `Bytes(x)` holding UTF-8 text.
    pub fn text(&mut self) -> &'a str {
        match core::str::from_utf8(self.bytes()) {
            Ok(text) => text,
            Err(_) => fail(self.error),
        }
    }

    /// `n` items of `size` bytes each, as one slice.
    pub fn items(&mut self, n: u64, size: usize) -> &'a [u8] {
        match usize::try_from(n).ok().and_then(|n| n.checked_mul(size)) {
            Some(len) => self.take(len),
            None => fail(self.error),
        }
    }

    /// Reverts unless every byte was read.
    pub fn end(&self) {
        if self.at != self.bytes.len() {
            fail(self.error);
        }
    }

    /// Reverts with the reader's error, for a value it read but cannot accept.
    pub fn refuse(&self) -> ! {
        fail(self.error)
    }
}

/// Builds an encoding.
#[derive(Default)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn put(mut self, bytes: &[u8]) -> Self {
        self.0.extend_from_slice(bytes);
        self
    }

    pub fn u8(self, v: u8) -> Self {
        self.put(&[v])
    }

    pub fn u16(self, v: u16) -> Self {
        self.put(&v.to_le_bytes())
    }

    pub fn u32(self, v: u32) -> Self {
        self.put(&v.to_le_bytes())
    }

    pub fn u64(self, v: u64) -> Self {
        self.put(&v.to_le_bytes())
    }

    pub fn u128(self, v: u128) -> Self {
        self.put(&v.to_le_bytes())
    }

    /// `Bytes(x)`.
    pub fn bytes(self, x: &[u8]) -> Self {
        self.u32(x.len() as u32).put(x)
    }

    pub fn finish(self) -> Vec<u8> {
        self.0
    }
}
