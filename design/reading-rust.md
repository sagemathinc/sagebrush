# Reading Sagebrush's Rust

A guide for someone who has written a lot of software (C, Python, Cython,
Magma, PARI/GP, Sage) and wants to **read** the Rust in Sagebrush, not
write it. It explains the language as it is actually used here, with real
excerpts, and answers the questions a mathematician-programmer tends to ask:
mutability, crates, the borrow checker, threads, integer types, operator
overloading, interrupting long computations, big integers, the Rust math
ecosystem, and compile times.

The numbers below (line counts, timings) were measured on the Sagebrush
tree in October 2026.

## 0. The shape of the code

About 18,000 lines of Rust, in a *workspace* of crates (packages):

| crate | lines | what |
|---|---:|---|
| `engine/classgroup` | 6,400 | class groups, units, number fields, ECM, LLL |
| `engine/modsym` | 5,800 | modular symbols, Hecke operators, newforms |
| `kernels` | 2,600 | NumPy-style array kernels for the browser (SIMD) |
| `engine/poly` | 900 | factoring in Z[x] (Zassenhaus) |
| `engine/ap` | 800 | a_p of elliptic curves (smalljac's method) |
| `engine/py`, `node`, `web`, `wasm`, `cli` | 1,100 | bindings: Python, Node, WebAssembly, command line |

The mathematics lives in the first five; the bindings are thin. A good first
read is `engine/classgroup/src/arith.rs` (word-size number theory) and then
`engine/classgroup/src/nf/zlin.rs` (integer linear algebra).

## 1. A first function, line by line

From `engine/classgroup/src/arith.rs`:

```rust
/// (g, x, y) with a x + b y = g = gcd(a, b) >= 0.
pub fn xgcd(a: i128, b: i128) -> (i128, i128, i128) {
    let (mut r0, mut r1, mut s0, mut s1, mut t0, mut t1) = (a, b, 1i128, 0i128, 0i128, 1i128);
    while r1 != 0 {
        let q = r0.div_euclid(r1);
        (r0, r1) = (r1, r0 - q * r1);
        (s0, s1) = (s1, s0 - q * s1);
        (t0, t1) = (t1, t0 - q * t1);
    }
    if r0 < 0 {
        (-r0, -s0, -t0)
    } else {
        (r0, s0, t0)
    }
}
```

- `///` starts a *doc comment* (it becomes the documentation of the next
  item; `//!` documents the enclosing file or module). Plain comments are
  `//`.
- `pub fn` is a public function. Parameters and the result have types,
  always written after a colon: `a: i128`. The result type follows `->`.
  `(i128, i128, i128)` is a tuple, like Python's.
- `let` introduces a variable. `mut` makes it changeable (section 2).
  `1i128` is the literal 1 with type `i128` (a 128-bit signed integer).
- Tuple assignment `(r0, r1) = (r1, r0 - q * r1)` is simultaneous, as in
  Python.
- `r0.div_euclid(r1)` is a method call on an integer: Euclidean division,
  quotient rounded so that the remainder is nonnegative. Rust's plain `/`
  on integers truncates toward zero, like C, not like Python's `//`.
- There is no `return`: **a block's value is its last expression**, the one
  without a trailing semicolon. Here the `if ... else ...` is the last
  expression of the function, and each branch's value is a tuple. Putting a
  `;` after it would make the function return `()` (the empty tuple, Rust's
  "nothing") and fail to compile. `return x;` exists for early exits.
- Braces are mandatory around `if` and loop bodies; parentheses around the
  condition are not used.

That is most of the syntax you need. The rest of this document is about
the parts that are genuinely different from other languages.

## 2. `let`, `mut` and shadowing

Variables are immutable unless declared `mut`:

```rust
let n = 5;        // n cannot change
let mut k = 0;    // k can
k += n;
```

Mutability is a property of the *binding*, checked at compile time; there
is no runtime cost. For a reader, `mut` is a useful signal: when you see
`let x = ...` you know `x` keeps that value for the rest of the scope.

The same name can be declared again, *shadowing* the old one. This is
common and is not mutation:

```rust
let ld = dk.to_f64().unwrap().abs().ln();   // a float
let x = ((4.0 * ld * ld) as u64).clamp(1 << 10, 1 << 15);
```

Types are inferred inside functions (`let q = r0.div_euclid(r1)` is an
`i128` because `r0` is), so you will see few type annotations there. They
are required on function signatures and struct fields, which therefore
document the code well.

Function parameters are also immutable unless written `mut b: u64` in the
signature (as in `powmod(mut b: u64, mut e: u64, p: u64)`); that only means
the function changes its own copy.

## 3. Ownership and borrowing (and whether the borrow checker matters)

This is Rust's one big idea. You need about a page of it to read the code.

**Every value has one owner.** A `Vec<BigInt>` (a growable array of big
integers) lives in one variable. Assigning it or passing it to a function
*moves* it: the old variable can no longer be used. To use a value without
taking it, you *borrow* a reference:

- `&x` is a shared (read-only) reference. Many can exist at once.
- `&mut x` is an exclusive (read-write) reference. Only one at a time, and
  no shared references meanwhile.

So in function signatures:

```rust
pub fn hnf(rows: &[Vec<BigInt>]) -> ZMat        // reads the rows, returns a new matrix
fn relations_from(fld: &Field, ib: &ZMat, budget: usize,
                  seen: &mut HashSet<Vec<(usize, i64)>>,
                  rels: &mut Vec<Relation>, ...) -> usize
```

`relations_from` reads the field and the ideal basis and *appends* to
`rels` and `seen`: the `&mut` says exactly which arguments it modifies.
This is the most useful thing the system gives a reader: **a function's
signature tells you what it can change.** In Python or C you have to read
the body (and everything it calls) to know.

`&[T]` is a *slice*: a view of a contiguous run of `T`s (all of a `Vec`, or
part of it). Functions take slices so that they work on any array-like
storage.

Small types such as integers, floats and `bool` are `Copy`: assigning them
copies, and the move rules never come up. Big integers are not `Copy`
(they own heap memory), which is why you see `.clone()` (an explicit deep
copy) and `&` around `BigInt` arithmetic:

```rust
let q = a[i][col].div_floor(&a[r][col]);
let pr = a[r].clone();                     // copy row r: we are about to change row i
for (x, y) in a[i].iter_mut().zip(&pr) {
    *x -= &q * y;                          // x: &mut BigInt, y: &BigInt
}
```

`*x` dereferences: "the value `x` points to". `&q * y` multiplies through
references, without consuming either operand.

**Is the borrow checker important for math code?** Less than its reputation
suggests, and in a specific way:

- Most mathematical code is functions from inputs to outputs over arrays
  and numbers. That style rarely fights the borrow checker. In Sagebrush
  the visible cost is the occasional `.clone()` (like `pr` above: Rust will
  not let you read row `r` while writing row `i` of the same matrix through
  two references) and index-based loops where you might have expected
  iterators.
- What it buys is real: no use-after-free, no dangling pointers, no
  iterator invalidation, and (section 7) **no data races**, all checked at
  compile time. Memory errors are the classic way C math libraries crash
  or, worse, silently corrupt results.
- Where it hurts is graph-like structures with shared mutable parts
  (doubly linked lists, mutable object graphs, caches). Sagebrush mostly
  avoids them. Where sharing is needed, you will see `Arc<T>` (a
  reference-counted pointer, like a Python object reference, safe across
  threads) and `Mutex<T>` (a lock), as in the newform cache in
  `engine/modsym/src/newforms.rs`.

You do not have to understand *lifetimes* (the `'a` annotations, as in
`Bound<'py, PyDict>`) to read the code. They name how long a borrow lasts,
appear mostly in the bindings, and the compiler infers them almost
everywhere else.

## 4. Types

### Integers

Rust's integer types say their width and signedness exactly:

| type | range | used for |
|---|---|---|
| `u8`, `u16`, `u32`, `u64`, `u128` | unsigned, 8 to 128 bits | primes, residues, bit tricks |
| `i8` ... `i64`, `i128` | signed | coefficients, exponents |
| `usize`, `isize` | pointer width (64 bits, or 32 in WebAssembly) | indices and lengths |

**`u128` and `i128` are native** and are used heavily (about 190 times):
the product of two 64-bit numbers is exact in 128 bits, so modular
multiplication needs no tricks:

```rust
#[inline]
pub fn mulmod(a: u64, b: u64, p: u64) -> u64 {
    if p <= u32::MAX as u64 && a < p && b < p {
        a * b % p // the common case, without the slow 128-bit division
    } else {
        ((a as u128 * b as u128) % p as u128) as u64
    }
}
```

On x86-64 and ARM64 a `u64 * u64 -> u128` product is one instruction;
128-bit *division* is a slow library call, which is why hot loops use
Barrett or Montgomery reduction instead (`ModD128` in `imag.rs`,
`Mont` in `nf/ecm.rs`).

`as` converts between numeric types. It never fails: it truncates or wraps
(`300u32 as u8` is 44, `-1i64 as u64` is 2^64 - 1, and a too-large `f64 as
i64` saturates). So an `as` in the code is a place where the author has
decided the value fits. Conversions that can fail are written
`u64::try_from(x)` or `x.to_u64()` and return an `Option` or `Result`.

**Overflow.** In a debug build, integer overflow is a panic (an immediate,
clean crash with a message). In a release build it wraps silently (two's
complement), unless overflow checks are enabled. Sagebrush's tests run
optimized but with overflow checks on (`[profile.test]` in
`engine/Cargo.toml`), so overflow bugs show up in testing. Code that needs
explicit behavior says so: `checked_mul` (returns `None` on overflow),
`wrapping_mul`, `saturating_sub`.

Floats are `f32` and `f64`, IEEE-754, with the usual methods
(`x.ln()`, `x.sqrt()`, `x.abs()`). `f64` is used for numeric estimates
(embeddings, LLL Gram-Schmidt, analytic class number estimates); results
that must be exact are never decided by floats alone (see `bnf.rs`, where
every floating-point decision is confirmed exactly).

### Compound types

- `Vec<T>`: growable array (Python list of one type). `vec![0; n]` makes n
  zeros. `v.len()`, `v.push(x)`, `v[i]` (panics if out of range).
- `[T; N]`: fixed-size array, e.g. `[f64; 29]` for a table of constants.
- `HashMap<K, V>`, `HashSet<T>`: Python's dict and set.
- `String` (owned text) and `&str` (borrowed text).
- `type ZMat = Vec<Vec<BigInt>>;` is a *type alias*, just a name: an
  integer matrix as a vector of rows.

### `Option` and `Result`: no null, no exceptions

```rust
enum Option<T> { Some(T), None }
enum Result<T, E> { Ok(T), Err(E) }
```

A function that might not produce a value returns `Option<T>`; one that
might fail returns `Result<T, E>`, usually `Result<T, String>` here, with a
message. Callers must deal with both cases; there are no null pointers and
no exceptions. The common patterns:

```rust
let Some(b) = best else { break };          // take the value or leave the loop
match solve_rows(basis, v) { Some(cs) => ..., None => false }
let ps = decompose(&o, &dk, p)?;            // on Err, return the error from this function now
let ld = dk.to_f64().unwrap();              // "cannot fail here"; panics if it does
```

The `?` operator is the idiom to know: `f()?` means "if `f` failed,
return its error from the current function, else continue with the
value". It plays the role of exception propagation, but it is visible at
every call that can fail. The bindings turn an `Err(String)` into a Python
`ValueError` (`engine/py`), so a bad argument from Python is an exception,
never a crash.

`unwrap()` and `expect("...")` mean "this cannot fail" and panic if it does.
A panic is a bug, not an error path.

### Structs, `impl` and traits

```rust
pub struct PrimeIdeal {
    pub p: u64,
    pub e: u32,
    pub f: u32,
    pub pi: Vec<BigInt>,
    pub basis: ZMat,
    ...
}

impl PrimeIdeal {
    pub fn norm(&self) -> BigInt { BigInt::from(self.p).pow(self.f) }
}
```

A `struct` is plain data (no inheritance). Methods live in `impl` blocks.
`&self` is the receiver, borrowed read-only; `&mut self` would let the
method change the struct. `Self` (capital S) is the type itself.

`#[derive(Clone, Debug)]` above a struct asks the compiler to generate
copying and debug-printing.

A **trait** is an interface, like a Python protocol or a Haskell type
class: `Clone`, `Debug`, `Add` (the `+` operator), `Iterator`, `Send` and
`Sync` (section 7). *Generics* are written with angle brackets and trait
bounds:

```rust
pub fn map_slice<A: Sync, T: Send, F: Fn(&A) -> T + Sync + Send>(xs: &[A], f: F) -> Vec<T>
```

"For any types A and T and any function F from &A to T, where these can be
shared or sent between threads." The compiler generates a specialized copy
for each use (*monomorphization*), so generic code costs nothing at run
time, and some compile time (section 13).

`enum` is more than C's enums: each variant can carry data (like `Option`
above, or an algebraic data type in ML/Haskell). `match` takes them apart
and must cover every case.

## 5. Closures and iterators

Much of the code is iterator chains, Rust's equivalent of comprehensions:

```rust
let norms: Vec<u64> = split.iter()
    .take_while(|s| (s.0 as f64) < bound)
    .flat_map(|(p, degs)| degs.iter().filter_map(move |&(f, _)| p.checked_pow(f)))
    .collect();
```

reads as the Python

```python
norms = [p**f for (p, degs) in takewhile(lambda s: s[0] < bound, split)
               for (f, _) in degs]           # (skipping overflows)
```

- `|x| expr` is a closure (lambda). `move` makes it own what it captures.
- `.iter()` borrows the elements, `.iter_mut()` borrows them mutably,
  `.into_iter()` consumes the collection.
- `.map`, `.filter`, `.zip`, `.enumerate`, `.sum()`, `.max()`,
  `.collect()` (into a `Vec`, `HashMap`, ...) do what their names say.
- `(0..n)` is the range 0, ..., n-1; `(1..=n)` includes n.

These compile to the same machine code as hand-written loops, so both
styles are used freely; prefer whichever reads better.

## 6. Crates, modules and visibility

- A **crate** is a compilation unit: a library or a program. Its manifest
  is `Cargo.toml` (name, version, license, dependencies, features).
- A **workspace** groups crates that are built together:
  `engine/Cargo.toml` lists `modsym`, `ap`, `poly`, `classgroup`, ... and
  sets the release profile for all of them.
- Inside a crate, **modules** are files: `src/lib.rs` is the root, and
  `mod nf;` there includes `src/nf/mod.rs`, which says `pub mod bnf;` to
  include `src/nf/bnf.rs`. So the path `crate::nf::bnf::bnfinit` is the
  function `bnfinit` in that file.
- `use num_bigint::BigInt;` imports a name, like Python's `from ... import`.
  `use super::embed::lll;` reaches a sibling module.
- **Visibility:** everything is private to its module unless marked `pub`.
  `pub(crate)` means visible within the crate but not to users of it. So
  `pub` items are the API; the rest are implementation details you can
  change freely.

Dependencies are declared in `Cargo.toml` with versions:

```toml
[dependencies]
num-bigint = "0.4"
sagebrush-poly = { path = "../poly" }   # a crate in this repository

[dev-dependencies]
sagebrush-flint = { path = "../flint" } # only for tests (here: FLINT as an oracle)

[features]
default = ["parallel"]
parallel = ["dep:rayon"]                # optional multithreading
```

`cargo` downloads, builds and links everything; there is no separate build
system, no `configure`, and no C compiler involved in Sagebrush's own
crates. The exact versions used are pinned in `Cargo.lock`.

**Conditional compilation** is by attributes: `#[cfg(feature = "parallel")]`
compiles an item only with that feature, `#[cfg(target_arch = "wasm32")]`
only for WebAssembly, and `#[cfg(test)] mod tests { ... }` holds tests in
the same file as the code. Tests are functions marked `#[test]`, run by
`cargo test`; `examples/*.rs` are small programs (`cargo run --example
bnf -- ...`).

## 7. Threads

Rust's thread safety is its second big idea, and it is the reason the
borrow checker is worth having for math software.

Two marker traits, checked by the compiler:

- `Send`: a value can be moved to another thread.
- `Sync`: a value can be read from several threads at once.

`BigInt`, `Vec<u64>` and ordinary structs are both. A type that is not
safe to share (for example, a non-atomic reference count) is not, and the
compiler refuses to let it cross threads. Combined with the `&`/`&mut`
rule (many readers *or* one writer), this means a program that compiles has
**no data races**: no two threads can write the same memory, or one write
while another reads, without a lock or an atomic. You can still deadlock or
compute the wrong thing, but not corrupt memory nondeterministically.

In practice Sagebrush uses **rayon**, a data-parallelism library. Changing
`.iter()` to `.par_iter()` spreads the work over a thread pool:

```rust
pub fn map_slice<A: Sync, T: Send, F: Fn(&A) -> T + Sync + Send>(xs: &[A], f: F) -> Vec<T> {
    #[cfg(feature = "parallel")]
    return xs.par_iter().map(f).collect();
    #[cfg(not(feature = "parallel"))]
    return xs.iter().map(f).collect();
}
```

(`engine/modsym/src/par.rs`.) The modular symbols engine applies Hecke
operators to basis elements this way, and `ap` computes a_p for many primes
at once. The bounds `Sync + Send` on `f` are the compiler's guarantee that
the closure can safely run on many threads. Results come back in order, so
parallel and sequential runs give identical answers.

For a math library this is the important point: **parallelizing a correct
sequential loop is usually a one-word change, and the compiler rejects it
if the loop has hidden shared mutable state.** In C, C++ or Cython you find
such bugs (a static buffer, a global cache) by intermittent wrong answers.
PARI, for instance, has a global stack per thread and needs care to use
from threads; Sage mostly runs one computation per process.

From Python, the bindings release the GIL around every engine call
(`py.detach(...)` in `engine/py/src/lib.rs`) and run it on a rayon pool
with `threads` workers, so other Python threads keep running.

The browser is single-threaded today (each notebook runs in one Web
Worker). WebAssembly threads exist but need special HTTP headers
(cross-origin isolation); the `parallel` feature is off in the wasm build.

## 8. Operator overloading, and why Sagebrush rarely defines it

Rust has operator overloading: `a + b` calls `Add::add(a, b)`, and a type
implements the `Add` trait to support it (likewise `Mul`, `Neg`, `Index`,
`AddAssign` for `+=`, ...). Sagebrush *uses* it constantly, through
`BigInt`, `BigRational` and the primitive types, but defines it for **none**
of its own types (there are zero `impl Add for ...` in the tree). Reasons:

1. **The modulus is not part of the value.** Most arithmetic here is in
   `Z/pZ` for word-size `p`, or in an order of a number field. A residue
   is a plain `u64`, and the modulus (or a Barrett/Montgomery context, or the
   order's multiplication table) is passed explicitly:
   `mulmod(a, b, p)`, `mont.mul(a, b)`, `o.mul(x, y)`. Overloading `*`
   would require bundling the modulus into every element, which costs
   memory and time in inner loops and hides where reductions happen.
2. **Ownership makes overloaded operators on big values verbose.** For a
   non-`Copy` type, `a + b` consumes both operands, so you write
   `&a + &b` to keep them; `BigInt` code is full of `&`. For new types the
   gain over a named method is small.
3. **Visibility of cost.** In hot code it helps that a 128-bit reduction,
   a Montgomery product or a big-integer multiplication looks different
   from a machine multiplication.
4. **There are few user-facing numeric types in Rust at all.** The objects a
   user manipulates (number field elements, ideals, polynomials) live in the
   Python layer (`lib/_sage_*.py`), which does overload operators. The Rust
   engines expose functions on plain data (coefficient vectors, matrices).

This could change: a polynomial or number field element type in Rust that
other Rust programs use directly would naturally implement `Add` and `Mul`.

## 9. Panics, errors and `unsafe`

- A **panic** (`panic!`, a failed `unwrap`, an out-of-bounds index, overflow
  in a checked build) stops the computation with a message and a
  backtrace. It is never undefined behavior. The browser kernels are built
  with `panic = "abort"` (smaller code).
- Recoverable failures are `Result`s (section 4). Invalid input from a user
  (a non-prime where a prime is needed, a non-monic polynomial) is an
  `Err`, which becomes a Python `ValueError`.
- `unsafe` marks code where the programmer, not the compiler, guarantees
  memory safety: raw pointers, calls into C, CPU intrinsics. Sagebrush has
  55 uses, all in three places: the SIMD array kernels (`kernels/`),
  the WebAssembly boundary (`engine/web`, passing buffers to JavaScript) and
  the FLINT test bindings (`engine/flint`), plus an AVX2 fast path in the
  modular-symbols linear algebra (used only when the CPU has it). The mathematics in `classgroup`, `poly` and `ap` has none.
  `grep -rn unsafe` finds every place where a memory bug could hide.

## 10. Interrupting long computations (Ctrl-C)

Today Sagebrush has **no cooperative interruption**. Concretely:

- **From Python:** the engine call runs with the GIL released. Ctrl-C sets
  Python's interrupt flag, but the `KeyboardInterrupt` is only raised when
  the Rust call returns. State in Python is kept, but you wait.
- **In the browser:** the Interrupt button terminates the Web Worker and
  starts a new one (`worker.terminate()` in `web/index.html`), so every
  variable is lost: that is the only way to stop a running WebAssembly
  call.
- **Native command line:** Ctrl-C kills the process.

How it can be done, roughly in order of preference:

1. **A cancellation flag checked in the long loops.** A shared
   `AtomicBool` (or a counter) that the relation search, the sieve, ECM
   and the Hecke loops check every few milliseconds; on seeing it set they
   return `Err("interrupted")`, unwinding cleanly through `?`. Everything
   computed so far that lives in caches (or in the caller) stays valid.
   This is what Rust code normally does; the cost is a load per check.
2. **Who sets the flag:**
   - Native: a signal handler (crates `ctrlc` or `signal-hook`) that only
     sets the flag. Setting an atomic is one of the few things safe to do
     in a signal handler.
   - Python: the binding's handler, or a watchdog thread that calls PyO3's
     `Python::check_signals()` periodically and sets the flag when it
     reports `KeyboardInterrupt`. The engine then returns and Python raises
     the exception with the interpreter intact, as in Sage.
   - Browser: the page and the worker share a `SharedArrayBuffer`; the
     Interrupt button writes 1 into it and the Rust loops read it. This
     needs cross-origin isolation headers on sagebrush.space (also needed
     for threads), which are a site configuration change.
3. **What not to do:** PARI and Sage interrupt by `longjmp`ing out of the
   signal handler (`sig_on`/`sig_off` in Sage). In Rust that would skip
   destructors and leave data structures half-updated; jumping across Rust
   frames is undefined behavior. The flag approach is the safe equivalent,
   and because Rust returns through every frame, nothing leaks.

Long computations can also resume rather than restart: the class group code
could keep its relations so that a second call continues where the first
stopped. That is a design decision per algorithm.

## 11. Foundations: big integers and the rest of the stack

Sagebrush depends on very little (all MIT OR Apache-2.0):

| crate | role |
|---|---|
| `num-bigint`, `num-integer`, `num-traits`, `num-rational` | big integers and rationals |
| `rayon` | data parallelism |
| `pyo3` | Python bindings |
| `wasm-bindgen` | WebAssembly bindings |
| `serde_json` | the JSON request format of the engine dispatcher |

**How good is `num-bigint` compared to GMP?** Honestly: correct, portable,
pure Rust, and much slower for large numbers.

- It uses 64-bit limbs on 64-bit platforms (32-bit in WebAssembly) and
  schoolbook, Karatsuba and Toom-3 multiplication, but no FFT
  multiplication and none of GMP's hand-written assembly. For numbers of a
  few hundred bits it is roughly within a small factor of GMP; for millions
  of bits it is asymptotically worse.
- Sagebrush mostly avoids it in hot loops: the quadratic class group code
  works in `u64`/`u128` with Barrett reduction up to 2^126, ECM uses its
  own Montgomery arithmetic on fixed arrays of `u64` limbs, and modular
  symbols work modulo word-size primes with CRT. `BigInt` appears in setup,
  in lattice and HNF code, and in final results.
- In WebAssembly, big-integer code is roughly 30 times slower than native
  here (ECM on 2^128 + 1: 0.1 s native, 2.7 s in the browser). 32-bit limbs
  and the lack of a 64x64 -> 128-bit multiply in wasm32 account for much of
  it. Replacing `BigInt` in the hot spots with fixed-width or specialized
  arithmetic is a known lever.

Alternatives in the Rust world: `rug` (GMP and MPFR through C, LGPL, so not
usable in Sagebrush's permissive core), `malachite` (pure Rust and fast, but
LGPL-3.0, so also excluded), and `dashu`/`ibig` (pure Rust, MIT OR
Apache-2.0, generally faster than `num-bigint` on large inputs). If big-integer speed
becomes the bottleneck, swapping in `dashu` or writing a focused FFT
multiplication is possible without changing licenses.

## 12. The Rust math ecosystem

Broad but shallow for research mathematics:

- **Numerics and linear algebra:** `nalgebra` (small fixed and dynamic
  matrices), `ndarray` (NumPy-like arrays), `faer` (fast dense linear
  algebra, competitive with LAPACK-based code), `rustfft`, `statrs`.
  This part is mature.
- **Arbitrary precision:** `num-*`, `dashu`, `rug` (GMP/MPFR/MPC
  bindings), `malachite`.
- **Computer algebra:** a few projects (for example `symbolica`, which is
  source-available rather than open source, and the algebra
  library `feanor-math`), and bindings to C
  libraries such as FLINT. There is nothing like PARI, FLINT, Magma or Sage
  in pure Rust: no mature class groups, modular forms, elliptic curves or
  general number field algorithms.

That gap is Sagebrush's opportunity. What Rust offers in exchange for a
young ecosystem is a toolchain that makes portable, fast, safe, permissively
licensed code easy to distribute: one `cargo build`, wheels for every
platform from CI, and the same code in the browser.

## 13. Compile times

Measured on this project (16 cores):

| build | time |
|---|---:|
| `engine/classgroup` and its dependencies, release, from clean | 11 s |
| the same after touching one file | 9 s |
| debug build from clean | 4 s |
| debug build after touching one file | 0.4 s |
| `cargo check` (type checking only) | 2 s |
| the Python extension (every engine plus PyO3), release, from clean | 37 s |

Why release rebuilds are slow even for one-line changes: the release
profile uses **link-time optimization** and a single code-generation unit
(`lto = true`, `codegen-units = 1` in `engine/Cargo.toml`), which lets LLVM
optimize across crates (inlining `mulmod` into callers in another crate, for
example) but means the whole crate graph is re-optimized together. That is
a deliberate trade: slower builds, faster code. Generic code adds to it,
since each instantiation is compiled separately.

In daily work this is fine: `cargo check` gives type errors in seconds,
debug builds are fast, and tests run in an optimized-but-checked profile.
For comparison, building Sage from source takes hours, mostly in C and
Fortran dependencies; a full Sagebrush build including the WebAssembly
engine and the Python wheel takes a few minutes.

## 14. Reading tips

- Start from a public entry point: `engine/classgroup/src/api.rs` (the
  plain-data API used by Python and the browser), then follow calls.
  `pub fn` items are the interface of each file.
- File headers (`//!`) say what a module does and cite the source of each
  algorithm (Cohen's books, papers, the PARI documentation for interfaces).
- `#[cfg(test)] mod tests` at the bottom of a file shows how its functions
  are meant to be used, often with values checked against Sage or PARI.
- `cargo doc --open` in `engine/` builds browsable documentation from the
  doc comments, with links between types.
- An editor with rust-analyzer shows the inferred type of every variable
  on hover, which answers most "what is this?" questions immediately.

### A small phrasebook

| Rust | means |
|---|---|
| `let x = ...;` / `let mut x` | immutable / mutable variable |
| `&x`, `&mut x` | borrow for reading / for writing |
| `x.clone()` | deep copy |
| `Vec<T>`, `&[T]` | list of T / view of a list |
| `Option<T>`: `Some(v)` / `None` | maybe a value |
| `Result<T, E>`: `Ok(v)` / `Err(e)` | a value or an error |
| `f()?` | return f's error now, else use its value |
| `.unwrap()` | "cannot fail" (panics otherwise) |
| `\|x\| x + 1` | lambda |
| `for i in 0..n` | `for i in range(n)` |
| `impl T { fn f(&self) }` | methods of T |
| `trait`, `impl Trait for T` | interface, and T implements it |
| `x as u64` | numeric conversion (truncating) |
| `#[derive(...)]`, `#[cfg(...)]`, `#[test]` | generated code, conditional compilation, a test |
| `pub`, `pub(crate)` | public / crate-internal |
| `use a::b::C;` | import |
| `crate::`, `super::` | this crate's root / the parent module |
| `unsafe { ... }` | the programmer vouches for memory safety here |
