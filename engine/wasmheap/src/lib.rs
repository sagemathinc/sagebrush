//! The WebAssembly heap of Sagebrush's own wasm modules, bounded at its source
//! (PNG plan r8 §2.2; moved here from engine/raster so that each module that
//! needs it links this one copy): dlmalloc over our own system layer, the
//! only code that grows the memory.  A growth past the bound the host set
//! (begin) is refused there, before `memory.grow`, and recorded in a static
//! the host reads after the call (last_refusal), without anything allocated
//! to record or read it.  Each module exports these under its own prefix
//! (engine/raster's rs_begin, rs_last_refusal, rs_heap_base).
//!
//! The bound is on the instance's pages: memory.size + the growth asked for
//! may not exceed the pages it had when begin was called (its initial
//! pages: the stack, static data, the page holding __heap_base and the slack
//! above it, which the heap uses first) plus the pages begin allows.  So
//! the initial slack is counted once, in the initial pages.  Until begin
//! is called the heap is bounded only by WebAssembly's 4 GiB.
//!
//! A refusal is dlmalloc's null: a fallible allocation returns the call's
//! memory outcome; an infallible one traps (handle_alloc_error), and the host
//! finds the refusal recorded here.
//!
//! The bound and the refusal are atomics, not `static mut`: the modules are
//! single-threaded, so these compile to plain loads and stores, and nothing
//! but the allocator itself needs an unsafe block.
#![cfg(target_arch = "wasm32")]

use core::arch::wasm32;
use core::ptr::{addr_of, addr_of_mut, null_mut};
use core::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering::Relaxed};
use dlmalloc::{Allocator, Dlmalloc};
use std::alloc::{GlobalAlloc, Layout};

const PAGE: usize = 64 * 1024;

extern "C" {
    static __heap_base: u8;
    static __heap_end: u8;
}

/// A refused growth: the pages asked for, the memory's pages then, and the
/// most it may have (0, 0, 0: none since the call began).  The host reads
/// it as three u32s, little-endian.
#[repr(C)]
pub struct Refusal {
    pub need_pages: AtomicU32,
    pub size_pages: AtomicU32,
    pub limit_pages: AtomicU32,
}

static LIMIT_PAGES: AtomicUsize = AtomicUsize::new(usize::MAX);
static SLACK_USED: AtomicBool = AtomicBool::new(false);
static REFUSAL: Refusal = Refusal { need_pages: AtomicU32::new(0), size_pages: AtomicU32::new(0), limit_pages: AtomicU32::new(0) };

fn refuse(need: usize, size: usize, limit: usize) {
    REFUSAL.need_pages.store(need as u32, Relaxed);
    REFUSAL.size_pages.store(size as u32, Relaxed);
    REFUSAL.limit_pages.store(limit as u32, Relaxed);
}

struct Bounded;

// SAFETY: dlmalloc's system layer contract: `alloc` hands out either the initial
// memory's slack above __heap_base (once) or freshly grown, page-aligned pages
// that nothing else uses, zeroed by memory.grow; it never frees or remaps, and
// the static state it touches is used on the module's single thread.
#[allow(unsafe_code)]
unsafe impl Allocator for Bounded {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        // first the initial memory's slack above the heap's base, once
        // (as dlmalloc's own wasm system layer does)
        if size != 0 && !SLACK_USED.load(Relaxed) {
            SLACK_USED.store(true, Relaxed);
            let (base, end) = (addr_of!(__heap_base) as usize, addr_of!(__heap_end) as usize);
            if base != 0 && end > base && end - base >= size {
                return (base as *mut u8, end - base, 0);
            }
        }
        let pages = size.div_ceil(PAGE);
        let now = wasm32::memory_size(0);
        let limit = LIMIT_PAGES.load(Relaxed);
        if now.saturating_add(pages) > limit {
            refuse(pages, now, limit);
            return (null_mut(), 0, 0);
        }
        let prev = wasm32::memory_grow(0, pages);
        if prev == usize::MAX {
            // (the host's own refusal, within the bound: recorded too)
            refuse(pages, now, now);
            return (null_mut(), 0, 0);
        }
        let base = prev * PAGE;
        let len = pages * PAGE;
        // (the last bytes of the address space: a pointer may not wrap
        // to 0, so they are not handed out, as dlmalloc's layer does)
        if base.wrapping_add(len) == 0 {
            return (base as *mut u8, len - 16, 0);
        }
        (base as *mut u8, len, 0)
    }

    fn remap(&self, _ptr: *mut u8, _old: usize, _new: usize, _can_move: bool) -> *mut u8 {
        null_mut()
    }

    fn free_part(&self, _ptr: *mut u8, _old: usize, _new: usize) -> bool {
        false
    }

    fn free(&self, _ptr: *mut u8, _size: usize) -> bool {
        false
    }

    fn can_release_part(&self, _flags: u32) -> bool {
        false
    }

    fn allocates_zeros(&self) -> bool {
        true
    }

    fn page_size(&self) -> usize {
        PAGE
    }
}

static mut DL: Dlmalloc<Bounded> = Dlmalloc::new_with_allocator(Bounded);

struct Heap;

// SAFETY: each method forwards to the one dlmalloc instance with the caller's
// layout, so dlmalloc's malloc/calloc/free/realloc contract is GlobalAlloc's;
// DL is used on the module's single thread, with no other reference live.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Heap {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        (*addr_of_mut!(DL)).malloc(l.size(), l.align())
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        (*addr_of_mut!(DL)).calloc(l.size(), l.align())
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        (*addr_of_mut!(DL)).free(p, l.size(), l.align())
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        (*addr_of_mut!(DL)).realloc(p, l.size(), l.align(), new_size)
    }
}

#[global_allocator]
static HEAP: Heap = Heap;

/// The host's bound: from now on the memory may grow by at most `pages`
/// pages over its size now (on a fresh instance, its initial pages).
pub fn begin(pages: u32) {
    LIMIT_PAGES.store(wasm32::memory_size(0).saturating_add(pages as usize), Relaxed);
    clear_refusal();
}

/// The last growth refused since the call began (all zero: none).
pub fn last_refusal() -> *const Refusal {
    &REFUSAL
}

/// Where the heap starts: below it the stack and static data.
pub fn heap_base() -> usize {
    addr_of!(__heap_base) as usize
}

/// At each call's start: no refusal yet.
pub fn clear_refusal() {
    refuse(0, 0, 0);
}
