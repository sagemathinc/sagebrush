//! Tests only, never shipped (no-cliffs C r15 section 1): allocations
//! through the global allocator the engine's module uses (std's dlmalloc on
//! wasm32-unknown-unknown; `engine/web` sets no `#[global_allocator]`), and
//! the memory's size, so engine/growth-probe/sweep.mjs can measure the real
//! page growth of a block against the growth envelope W(b).

/// Allocate `len` bytes (aligned to 8, as the engine's Vec<u64> blocks).
#[no_mangle]
pub extern "C" fn probe_alloc(len: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(len.max(1), 8).unwrap();
    unsafe { std::alloc::alloc(layout) }
}

/// Free a block from probe_alloc.
///
/// # Safety
/// `ptr` and `len` must come from one probe_alloc call.
#[no_mangle]
pub unsafe extern "C" fn probe_free(ptr: *mut u8, len: usize) {
    let layout = std::alloc::Layout::from_size_align(len.max(1), 8).unwrap();
    std::alloc::dealloc(ptr, layout)
}

/// The memory's size in 64 KiB pages.
#[no_mangle]
pub extern "C" fn probe_pages() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size::<0>() as u32
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}
