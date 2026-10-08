//! Monomial orders on packed exponent words.
//!
//! Words are packed as in [`crate::ZPoly`]: `bits` bits per variable, the
//! first variable in the highest field, so the words themselves compare in
//! lex order and add as the monomials multiply.  Other orders compare by a
//! key computed from the word: a u128, larger for the bigger monomial
//! (degree orders put the total degree in the upper 64 bits; degrevlex
//! complements the exponents, last variable first, so that a smaller
//! exponent of the last variable makes a bigger monomial).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    Lex,
    DegLex,
    DegRevLex,
    InvLex,
}

impl Order {
    pub fn parse(s: &str) -> Option<Order> {
        Some(match s {
            "lex" | "lp" => Order::Lex,
            "deglex" | "Dp" => Order::DegLex,
            "degrevlex" | "dp" | "grevlex" => Order::DegRevLex,
            "invlex" | "rp" => Order::InvLex,
            _ => return None,
        })
    }

    pub fn name(&self) -> &'static str {
        match self {
            Order::Lex => "lex",
            Order::DegLex => "deglex",
            Order::DegRevLex => "degrevlex",
            Order::InvLex => "invlex",
        }
    }
}

/// The geometry of packed words: n variables of `bits` bits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Packing {
    pub n: usize,
    pub bits: u32,
}

impl Packing {
    #[inline]
    pub fn mask(&self) -> u64 {
        if self.bits >= 64 {
            !0
        } else {
            (1u64 << self.bits) - 1
        }
    }

    #[inline]
    pub fn shift(&self, i: usize) -> u32 {
        (self.n - 1 - i) as u32 * self.bits
    }

    #[inline]
    pub fn exp(&self, w: u64, i: usize) -> u64 {
        (w >> self.shift(i)) & self.mask()
    }

    /// The top bit of every field: set after an addition that overflowed
    /// a field whose values were all below half its range.
    pub fn guard(&self) -> u64 {
        let top = 1u64 << (self.bits - 1);
        (0..self.n).fold(0u64, |g, i| g | (top << self.shift(i)))
    }

    pub fn pack(&self, e: &[u64]) -> u64 {
        e.iter().enumerate().fold(0u64, |w, (i, &x)| w | (x << self.shift(i)))
    }

    pub fn unpack(&self, w: u64) -> Vec<u64> {
        (0..self.n).map(|i| self.exp(w, i)).collect()
    }

    pub fn degree(&self, w: u64) -> u64 {
        (0..self.n).map(|i| self.exp(w, i)).sum()
    }

    /// Whether the monomial a divides b.
    #[inline]
    pub fn divides(&self, a: u64, b: u64) -> bool {
        (0..self.n).all(|i| self.exp(a, i) <= self.exp(b, i))
    }

    /// The least common multiple of two monomials.
    pub fn lcm(&self, a: u64, b: u64) -> u64 {
        (0..self.n).fold(0u64, |w, i| w | (self.exp(a, i).max(self.exp(b, i)) << self.shift(i)))
    }

    /// Whether two monomials are coprime.
    pub fn coprime(&self, a: u64, b: u64) -> bool {
        (0..self.n).all(|i| self.exp(a, i) == 0 || self.exp(b, i) == 0)
    }

    /// The order key of a word: bigger for the bigger monomial.
    #[inline]
    pub fn key(&self, o: Order, w: u64) -> u128 {
        match o {
            Order::Lex => w as u128,
            Order::DegLex => (self.degree(w) as u128) << 64 | w as u128,
            Order::DegRevLex => {
                let m = self.mask();
                let mut low = 0u64;
                for i in 0..self.n {
                    // variable i at shift i*bits: the last variable highest
                    low |= (m - self.exp(w, i)) << (i as u32 * self.bits);
                }
                (self.degree(w) as u128) << 64 | low as u128
            }
            Order::InvLex => {
                let mut low = 0u64;
                for i in 0..self.n {
                    low |= self.exp(w, i) << (i as u32 * self.bits);
                }
                low as u128
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders() {
        let p = Packing { n: 3, bits: 8 };
        let m = |e: [u64; 3]| p.pack(&e);
        // degrevlex: x*y*z^0 ... standard examples
        let (a, b) = (m([1, 1, 0]), m([0, 0, 2])); // xy vs z^2: same degree, z^2 smaller in degrevlex
        assert!(p.key(Order::DegRevLex, a) > p.key(Order::DegRevLex, b));
        let (a, b) = (m([2, 0, 1]), m([1, 2, 0])); // x^2 z vs x y^2: degrevlex: x y^2 bigger
        assert!(p.key(Order::DegRevLex, b) > p.key(Order::DegRevLex, a));
        assert!(p.key(Order::DegLex, a) > p.key(Order::DegLex, b));
        assert!(p.key(Order::Lex, m([1, 0, 0])) > p.key(Order::Lex, m([0, 5, 5])));
        assert!(p.key(Order::InvLex, m([0, 0, 1])) > p.key(Order::InvLex, m([5, 5, 0])));
        assert!(p.divides(m([1, 0, 1]), m([2, 3, 1])));
        assert!(!p.divides(m([1, 0, 2]), m([2, 3, 1])));
        assert_eq!(p.lcm(m([1, 0, 2]), m([2, 3, 1])), m([2, 3, 2]));
    }
}
