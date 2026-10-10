//! The group of Dirichlet characters mod N: generators of (Z/N)^*,
//! discrete logarithms, every character as an exponent table, conductors,
//! and characters from LMFDB's description (values on generators).

use crate::exact::factor;
use crate::general::Character;
use crate::p1::gcd;

/// (Z/N)^* as a product of cyclic groups <g_i> of orders o_i, with the
/// discrete logarithm of every unit.  Characters are vectors c with
/// chi(g_i) = zeta_(o_i)^(c_i); `exponent` is lcm(o_i), the exponent of the
/// group, and values are reported relative to zeta_exponent.
#[derive(Clone, Debug)]
pub struct DirichletGroup {
    pub n: u64,
    pub gens: Vec<u64>,
    pub orders: Vec<u64>,
    pub exponent: u64,
    /// logs[x]: exponent vector of x in the generators (empty for non-units).
    logs: Vec<Vec<u64>>,
    /// For each generator: the prime power p^r of N it lives in, and for
    /// p = 2 whether it is 5 (order 2^(r-2)) rather than -1 (order 2).
    parts: Vec<(u64, u32, bool)>,
}

fn crt_lift(a: u64, q: u64, n: u64) -> u64 {
    // The x mod n with x = a mod q and x = 1 mod n/q (q | n, gcd(q, n/q) = 1).
    let r = n / q;
    (0..q).map(|t| 1 + t * r).find(|x| x % q == a % q).unwrap() % n.max(1)
}

impl DirichletGroup {
    pub fn new(n: u64) -> Self {
        let mut gens = vec![];
        let mut orders = vec![];
        let mut parts = vec![];
        for (p, r) in factor(n) {
            let q = p.pow(r);
            if p == 2 {
                if r >= 2 {
                    gens.push(crt_lift(q - 1, q, n));
                    orders.push(2);
                    parts.push((2, r, false));
                }
                if r >= 3 {
                    gens.push(crt_lift(5, q, n));
                    orders.push(q / 4);
                    parts.push((2, r, true));
                }
            } else {
                // The least primitive root mod p^r.
                let phi = q / p * (p - 1);
                let fs: Vec<u64> = factor(phi).iter().map(|&(f, _)| f).collect();
                let g = (2..q).find(|&g| gcd(g, p) == 1 && fs.iter().all(|&f| pow_mod(g, phi / f, q) != 1)).unwrap();
                gens.push(crt_lift(g, q, n));
                orders.push(phi);
                parts.push((p, r, false));
            }
        }
        let exponent = orders.iter().fold(1u64, |l, &o| l / gcd(l, o) * o);
        // Discrete logs by walking the product of cyclic groups.
        let mut logs = vec![vec![]; n.max(1) as usize];
        let total: u64 = orders.iter().product();
        let mut v = vec![0u64; gens.len()];
        for _ in 0..total {
            let x = gens.iter().zip(&v).fold(1 % n.max(1), |acc, (&g, &e)| mul_mod(acc, pow_mod(g, e, n), n));
            logs[x as usize] = v.clone();
            for i in 0..v.len() {
                v[i] += 1;
                if v[i] < orders[i] {
                    break;
                }
                v[i] = 0;
            }
        }
        if n == 1 {
            logs[0] = vec![];
        }
        DirichletGroup { n, gens, orders, exponent, logs, parts }
    }

    pub fn is_unit(&self, x: u64) -> bool {
        self.n == 1 || gcd(x % self.n, self.n) == 1
    }

    pub fn log(&self, x: u64) -> &[u64] {
        &self.logs[(x % self.n.max(1)) as usize]
    }

    /// Number of characters, phi(N).
    pub fn order(&self) -> u64 {
        self.orders.iter().product()
    }

    /// The c-th character in a fixed enumeration (mixed radix in `orders`).
    pub fn vector(&self, mut c: u64) -> Vec<u64> {
        self.orders.iter().map(|&o| {
            let x = c % o;
            c /= o;
            x
        }).collect()
    }

    pub fn index(&self, v: &[u64]) -> u64 {
        v.iter().zip(&self.orders).rev().fold(0, |acc, (&x, &o)| acc * o + x % o)
    }

    /// The exponent of chi_v(x) relative to zeta_exponent (None for a non-unit).
    pub fn value(&self, v: &[u64], x: u64) -> Option<u64> {
        if !self.is_unit(x) {
            return None;
        }
        let l = self.log(x);
        Some(l.iter().zip(v).zip(&self.orders).fold(0, |acc, ((&a, &c), &o)| (acc + a * c % o * (self.exponent / o)) % self.exponent))
    }

    /// The conductor of chi_v, from its components: for odd p a character of
    /// (Z/p^r)^* of order o > 1 has conductor p^(1 + v_p(o)); mod 2^r one
    /// whose restriction to <5> has order 2^s > 1 has conductor 2^(s+2), else
    /// 4 if it is odd, else 1.  (Character::conductor scans every unit.)
    pub fn conductor_of(&self, v: &[u64]) -> u64 {
        let mut f = 1u64;
        let (mut two_minus, mut two_five) = (false, 0u32);
        for ((&(p, _, five), &c), &o) in self.parts.iter().zip(v).zip(&self.orders) {
            let ord = o / gcd(c % o, o); // the order of this component
            if p == 2 {
                if five {
                    two_five = ord.trailing_zeros();
                } else {
                    two_minus = ord > 1;
                }
            } else if ord > 1 {
                let (mut e, mut x) = (1, ord);
                while x % p == 0 {
                    x /= p;
                    e += 1;
                }
                f *= p.pow(e);
            }
        }
        if two_five > 0 {
            f << (two_five + 2)
        } else if two_minus {
            f * 4
        } else {
            f
        }
    }

    pub fn character(&self, v: &[u64]) -> Character {
        let e = self.exponent.max(1);
        let exps = (0..self.n.max(1)).map(|x| self.value(v, x).map_or(u32::MAX, |t| t as u32)).collect();
        Character::from_exponents(self.n.max(1), e, exps).expect("a character").minimal()
    }

    /// The vector of a character given by its exponent table (any order).
    pub fn vector_of(&self, eps: &Character) -> Vec<u64> {
        self.gens.iter().zip(&self.orders).map(|(&g, &o)| {
            let e = eps.exponent(g as i64).unwrap() as u64;
            // eps(g) = zeta_ord^e = zeta_o^(e o / ord)
            (e * o / eps.order) % o
        }).collect()
    }
}

pub(crate) fn mul_mod(a: u64, b: u64, n: u64) -> u64 {
    (a as u128 * b as u128 % n.max(1) as u128) as u64
}

pub(crate) fn pow_mod(mut b: u64, mut e: u64, n: u64) -> u64 {
    let mut r = 1 % n.max(1);
    b %= n.max(1);
    while e > 0 {
        if e & 1 == 1 {
            r = mul_mod(r, b, n);
        }
        b = mul_mod(b, b, n);
        e >>= 1;
    }
    r
}

impl Character {
    /// LMFDB's description: chi(gens[i]) = zeta_order^vals[i], where the
    /// gens generate (Z/N)^* (LMFDB's `char_values` = [N, order, gens, vals]).
    pub fn from_generators(n: u64, order: u64, gens: &[u64], vals: &[u64]) -> Result<Character, String> {
        crate::check_level(n)?;
        if order == 0 || gens.len() != vals.len() {
            return Err("a character is (order >= 1, gens, vals) with as many vals as gens".into());
        }
        // Every value is a phi(N)-th root of unity, so zeta_order^v lies in
        // mu_r, r = gcd(order, phi(N)) < 2^31: rewrite it as zeta_r^(v/(order/r)).
        // (Reducing mod a huge order and truncating to u32 would change chi.)
        let phi = crate::exact::factor(n.max(1)).iter().fold(1u64, |acc, &(p, e)| acc * (p - 1) * p.pow(e as u32 - 1));
        let r = gcd(order, phi);
        let step = order / r;
        let mut red = Vec::with_capacity(vals.len());
        for &v in vals {
            let v = v % order;
            if v % step != 0 {
                return Err(format!("zeta_{}^{} is not a value of a character mod {}", order, v, n));
            }
            red.push(v / step);
        }
        let (order, vals) = (r, &red[..]);
        let mut exps = vec![u32::MAX; n.max(1) as usize];
        exps[(1 % n.max(1)) as usize] = 0;
        // Breadth-first closure of {1} under multiplication by the generators.
        let mut queue = vec![1 % n.max(1)];
        while let Some(x) = queue.pop() {
            for (&g, &v) in gens.iter().zip(vals) {
                let y = mul_mod(x, g, n);
                let e = ((exps[x as usize] as u64 + v) % order) as u32;
                if exps[y as usize] == u32::MAX {
                    exps[y as usize] = e;
                    queue.push(y);
                } else if exps[y as usize] != e {
                    return Err(format!("inconsistent values at {}", y));
                }
            }
        }
        Ok(Character::from_exponents(n.max(1), order, exps)?.minimal())
    }

    /// The character mod m (cond | m | N) inducing this one.
    pub fn restrict(&self, m: u64) -> Character {
        assert!(self.n % m == 0 && m % self.conductor() == 0);
        let exps = (0..m).map(|x| {
            if m > 1 && gcd(x, m) != 1 {
                return u32::MAX;
            }
            let y = (0..self.n / m).map(|t| x + t * m).find(|&y| gcd(y, self.n) == 1 || self.n == 1).unwrap();
            self.exponent(y as i64).unwrap()
        }).collect();
        Character::from_exponents(m, self.order, exps).expect("restriction").minimal()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conductor_of_matches_the_scan() {
        for n in 1..400u64 {
            let g = DirichletGroup::new(n);
            for c in 0..g.order() {
                let v = g.vector(c);
                assert_eq!(g.conductor_of(&v), g.character(&v).conductor(), "N = {} chi = {:?}", n, v);
            }
        }
    }

    #[test]
    fn huge_order_presentation() {
        // MOD-F11: chi(2) = -1 mod 3, presented with order 2^33.
        for (order, v) in [(2u64, 1u64), (4, 2), (1 << 33, 1 << 32)] {
            let c = Character::from_generators(3, order, &[2], &[v]).unwrap();
            assert_eq!((c.order, c.conductor()), (2, 3), "order {}", order);
        }
        assert!(Character::from_generators(3, 1 << 33, &[2], &[1]).is_err());
    }

    #[test]
    fn groups_and_conductors() {
        for n in 1..200u64 {
            let g = DirichletGroup::new(n);
            let phi = (1..=n).filter(|&x| gcd(x, n) == 1).count() as u64;
            assert_eq!(g.order(), phi.max(1), "N = {}", n);
            // Number of primitive characters mod d summed over d | N is phi(N).
            let prim = (0..g.order()).filter(|&c| g.character(&g.vector(c)).conductor() == n).count() as u64;
            let mobius_count: u64 = {
                // phi*mu (Dirichlet convolution) is multiplicative:
                // p^r -> p^r - 2 p^(r-1) + p^(r-2) (r >= 2), p - 2 (r = 1).
                factor(n).iter().map(|&(p, r)| {
                    if r == 1 { p - 2 } else { p.pow(r) - 2 * p.pow(r - 1) + p.pow(r - 2) }
                }).product()
            };
            assert_eq!(prim, mobius_count, "N = {}", n);
        }
    }

    #[test]
    fn lmfdb_description_roundtrip() {
        // 13.2.e: [13, 6, [2], [1]], order 6.
        let eps = Character::from_generators(13, 6, &[2], &[1]).unwrap();
        assert_eq!((eps.order, eps.conductor()), (6, 13));
        let g = DirichletGroup::new(13);
        assert_eq!(g.character(&g.vector_of(&eps)).order, 6);
        // A character mod 39 trivial on the 3-part has conductor 13 and
        // restricts to the character mod 13 with the same value at 2.
        let g39 = DirichletGroup::new(39);
        let chi = g39.character(&[0, 2]);
        assert_eq!(chi.conductor(), 13);
        let r = chi.restrict(13);
        let want = Character::from_generators(13, 6, &[2], &[1]).unwrap();
        assert_eq!((r.order, r.exponent(2), r.conductor()), (want.order, want.exponent(2), 13));
    }
}
