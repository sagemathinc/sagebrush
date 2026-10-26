//! The engine's one parallel wrapper (no-cliffs C r8 section 2, r9 section 4;
//! C-2c scope r2 section 1).  Every parallel entry point of the engine crates
//! goes through this module (`scripts/check-par.mjs` fails CI on any other).
//!
//! - Every closure it runs, including each one spawned in a scope, runs under
//!   the context of the thread that spawned it: the ledger chain (so a
//!   reservation is its caller's) and the exclusive flag.  The context is
//!   installed for that closure only and the worker's previous one comes back
//!   afterwards, on success, error, panic or Stop alike.  Only identity is
//!   carried: never an asking call or an operation (their thread-bound guards
//!   stay on the owner thread).
//! - In exclusive mode (`sagebrush_ledger::is_exclusive`) every entry runs
//!   sequentially on its calling thread, in order.
//! - Before handing work out, each entry refreshes a stale total where the
//!   host lets this thread ask its source (`refresh_if_owner`); on a worker
//!   that does nothing.
//! - Without the `parallel` feature (WebAssembly) the rayon-style entries are
//!   sequential; `thread_scope` uses the standard library's threads.

use sagebrush_ledger::{refresh_if_owner, Context};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// The context to hand out, after a refresh on the owner (if this is it).
fn handoff() -> Context {
    refresh_if_owner();
    Context::current()
}

/// f(i) for i in 0..n, in order.
pub fn map_range<T: Send, F: Fn(usize) -> T + Sync + Send>(n: usize, f: F) -> Vec<T> {
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        return (0..n)
            .into_par_iter()
            .map(move |i| {
                let _g = ctx.enter();
                f(i)
            })
            .collect();
    }
    let _ = ctx;
    (0..n).map(f).collect()
}

/// f(x) for x in xs, in order.
pub fn map_slice<A: Sync, T: Send, F: Fn(&A) -> T + Sync + Send>(xs: &[A], f: F) -> Vec<T> {
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        return xs
            .par_iter()
            .map(move |x| {
                let _g = ctx.enter();
                f(x)
            })
            .collect();
    }
    let _ = ctx;
    xs.iter().map(f).collect()
}

/// f(index, element) for every element.
pub fn for_each_mut<A: Send, F: Fn(usize, &mut A) + Sync + Send>(xs: &mut [A], f: F) {
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        xs.par_iter_mut().enumerate().for_each(move |(i, x)| {
            let _g = ctx.enter();
            f(i, x)
        });
        return;
    }
    let _ = ctx;
    xs.iter_mut().enumerate().for_each(|(i, x)| f(i, x));
}

/// f(chunk index, chunk) over consecutive chunks of `size` elements.
pub fn for_each_chunk_mut<A: Send, F: Fn(usize, &mut [A]) + Sync + Send>(xs: &mut [A], size: usize, f: F) {
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        xs.par_chunks_mut(size).enumerate().for_each(move |(i, x)| {
            let _g = ctx.enter();
            f(i, x)
        });
        return;
    }
    let _ = ctx;
    xs.chunks_mut(size).enumerate().for_each(|(i, x)| f(i, x));
}

/// (a(), b()), possibly in parallel.
pub fn join<A, B, RA, RB>(a: A, b: B) -> (RA, RB)
where
    A: FnOnce() -> RA + Send,
    B: FnOnce() -> RB + Send,
    RA: Send,
    RB: Send,
{
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        return rayon::join(
            move || {
                let _g = ctx.enter();
                a()
            },
            move || {
                let _g = ctx.enter();
                b()
            },
        );
    }
    let _ = ctx;
    (a(), b())
}

/// A rayon-style scope whose only spawn capability is the wrapped one
/// ([`Scope::spawn`]): there is no way to reach an unwrapped spawn from it.
pub struct Scope<'a, 'scope> {
    #[cfg(feature = "parallel")]
    inner: Option<&'a rayon::Scope<'scope>>,
    ctx: Context,
    _lt: std::marker::PhantomData<(&'a (), fn(&'scope ()))>,
}

impl<'scope> Scope<'_, 'scope> {
    /// Run f, possibly on another thread, under this scope's context; the
    /// scope waits for it.  Sequential (now, on this thread) in exclusive
    /// mode or without the `parallel` feature.
    pub fn spawn<F>(&self, f: F)
    where
        F: for<'b> FnOnce(&Scope<'b, 'scope>) + Send + 'scope,
    {
        let ctx = self.ctx;
        #[cfg(feature = "parallel")]
        if let Some(s) = self.inner {
            s.spawn(move |s2| {
                let _g = ctx.enter();
                f(&Scope { inner: Some(s2), ctx, _lt: std::marker::PhantomData })
            });
            return;
        }
        let _g = ctx.enter();
        f(&Scope {
            #[cfg(feature = "parallel")]
            inner: None,
            ctx,
            _lt: std::marker::PhantomData,
        })
    }
}

/// A scope: op runs here, and every closure spawned in it has finished when
/// this returns.
pub fn scope<'scope, OP, R>(op: OP) -> R
where
    OP: for<'a> FnOnce(&Scope<'a, 'scope>) -> R + Send,
    R: Send,
{
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        return rayon::scope(move |s| op(&Scope { inner: Some(s), ctx, _lt: std::marker::PhantomData }));
    }
    op(&Scope {
        #[cfg(feature = "parallel")]
        inner: None,
        ctx,
        _lt: std::marker::PhantomData,
    })
}

/// The standard library's scoped threads, wrapped: [`ThreadScope::spawn`] is
/// the only spawn capability, and each spawned closure runs under the
/// spawning thread's context.  In exclusive mode a spawn runs its closure
/// now, on this thread (a panic then propagates at once, as in sequential
/// code).
#[derive(Clone, Copy)]
pub struct ThreadScope<'scope, 'env: 'scope> {
    inner: Option<&'scope std::thread::Scope<'scope, 'env>>,
    ctx: Context,
}

/// A spawned closure's result.
pub enum Handle<'scope, T> {
    Thread(std::thread::ScopedJoinHandle<'scope, T>),
    Done(T),
}

impl<T> Handle<'_, T> {
    /// Its result (Err: the thread panicked), as `ScopedJoinHandle::join`.
    pub fn join(self) -> std::thread::Result<T> {
        match self {
            Handle::Thread(h) => h.join(),
            Handle::Done(t) => Ok(t),
        }
    }
}

impl<'scope> ThreadScope<'scope, '_> {
    pub fn spawn<F, T>(&self, f: F) -> Handle<'scope, T>
    where
        F: FnOnce() -> T + Send + 'scope,
        T: Send + 'scope,
    {
        let ctx = self.ctx;
        match self.inner {
            Some(s) => Handle::Thread(s.spawn(move || {
                let _g = ctx.enter();
                f()
            })),
            None => {
                let _g = ctx.enter();
                Handle::Done(f())
            }
        }
    }
}

/// `std::thread::scope`, wrapped (see [`ThreadScope`]).
pub fn thread_scope<'env, F, T>(f: F) -> T
where
    F: for<'scope> FnOnce(ThreadScope<'scope, 'env>) -> T,
{
    let ctx = handoff();
    if ctx.exclusive {
        return f(ThreadScope { inner: None, ctx });
    }
    std::thread::scope(|s| f(ThreadScope { inner: Some(s), ctx }))
}

/// f on a pool of `threads` threads (0: rayon's default), under this thread's
/// context; on this thread in exclusive mode or without the `parallel`
/// feature.
pub fn install<T: Send>(threads: usize, f: impl FnOnce() -> T + Send) -> T {
    let ctx = handoff();
    #[cfg(feature = "parallel")]
    if !ctx.exclusive {
        return rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap().install(move || {
            let _g = ctx.enter();
            f()
        });
    }
    let _ = (ctx, threads);
    f()
}

/// The number of threads parallel entries use here: the current pool's (in
/// [`install`], its size), or 1 without the `parallel` feature.
pub fn current_num_threads() -> usize {
    #[cfg(feature = "parallel")]
    return rayon::current_num_threads();
    #[cfg(not(feature = "parallel"))]
    return 1;
}

#[cfg(test)]
mod tests;
