//! The WebAssembly heap, bounded at its source (PNG plan r8 §2.2): dlmalloc
//! over our own system layer, the only code that grows the memory.  A growth
//! past the bound the host set (rs_begin) is refused there, before
//! `memory.grow`, and recorded in a static the host reads after the call
//! (rs_last_refusal), without anything allocated to record or read it.
//!
//! The bound is on the instance's pages: memory.size + the growth asked for
//! may not exceed the pages it had when rs_begin was called (its initial
//! pages: the stack, static data, the page holding __heap_base and the slack
//! above it, which the heap uses first) plus the pages rs_begin allows.  So
//! the initial slack is counted once, in the initial pages.  Until rs_begin
//! is called the heap is bounded only by WebAssembly's 4 GiB.
//!
//! A refusal is dlmalloc's null: a fallible allocation (mem.rs) returns the
//! call's memory outcome; an infallible one traps (handle_alloc_error), and
//! the host finds the refusal recorded here.

use core::arch::wasm32;
use core::ptr::{addr_of, addr_of_mut, null_mut};
use dlmalloc::{Allocator, Dlmalloc};
use std::alloc::{GlobalAlloc, Layout};

const PAGE: usize = 64 * 1024;

extern "C" {
    static __heap_base: u8;
    static __heap_end: u8;
}

/// A refused growth: the pages asked for, the memory's pages then, and the
/// most it may have (0, 0, 0: none since the call began).
#[repr(C)]
pub struct Refusal {
    pub need_pages: u32,
    pub size_pages: u32,
    pub limit_pages: u32,
}

// (single-threaded: the module has no threads, and the host calls it from
// one)
static mut LIMIT_PAGES: usize = usize::MAX;
static mut SLACK_USED: bool = false;
static mut REFUSAL: Refusal = Refusal { need_pages: 0, size_pages: 0, limit_pages: 0 };

struct Bounded;

// SAFETY: dlmalloc's system layer contract: `alloc` hands out either the initial
// memory's slack above __heap_base (once) or freshly grown, page-aligned pages
// that nothing else uses, zeroed by memory.grow; it never frees or remaps, and
// the static state it touches is used on the module's single thread.
#[allow(unsafe_code)]
unsafe impl Allocator for Bounded {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        unsafe {
            // first the initial memory's slack above the heap's base, once
            // (as dlmalloc's own wasm system layer does)
            if size != 0 && !*addr_of!(SLACK_USED) {
                *addr_of_mut!(SLACK_USED) = true;
                let (base, end) = (addr_of!(__heap_base) as usize, addr_of!(__heap_end) as usize);
                if base != 0 && end > base && end - base >= size {
                    return (base as *mut u8, end - base, 0);
                }
            }
            let pages = size.div_ceil(PAGE);
            let now = wasm32::memory_size(0);
            let limit = *addr_of!(LIMIT_PAGES);
            if now.saturating_add(pages) > limit {
                *addr_of_mut!(REFUSAL) = Refusal { need_pages: pages as u32, size_pages: now as u32, limit_pages: limit as u32 };
                return (null_mut(), 0, 0);
            }
            let prev = wasm32::memory_grow(0, pages);
            if prev == usize::MAX {
                // (the host's own refusal, within the bound: recorded too)
                *addr_of_mut!(REFUSAL) = Refusal { need_pages: pages as u32, size_pages: now as u32, limit_pages: now as u32 };
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
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); LIMIT_PAGES is written on the module's single thread.
#[allow(unsafe_code)]
pub extern "C" fn rs_begin(pages: u32) {
    unsafe {
        *addr_of_mut!(LIMIT_PAGES) = wasm32::memory_size(0).saturating_add(pages as usize);
    }
    clear_refusal();
}

/// The last growth refused since the call began (all zero: none).
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn rs_last_refusal() -> *const Refusal {
    addr_of!(REFUSAL)
}

/// Where the heap starts: below it the stack and static data.
#[no_mangle]
// SAFETY: an export of the raster module's wasm ABI (no_mangle; the rs_ prefix keeps
// the symbol unique); no unsafe operation.
#[allow(unsafe_code)]
pub extern "C" fn rs_heap_base() -> usize {
    addr_of!(__heap_base) as usize
}

/// At each call's start: no refusal yet.
// SAFETY: REFUSAL is written on the module's single thread, with no reference to
// it live.
#[allow(unsafe_code)]
pub fn clear_refusal() {
    unsafe {
        *addr_of_mut!(REFUSAL) = Refusal { need_pages: 0, size_pages: 0, limit_pages: 0 };
    }
}
