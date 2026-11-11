//! Memory and panics. Memory starts at the module's initial pages and grows
//! only when an invocation needs more (Ting wiki: applications/writing-programs,
//! keeping it cheap). Nothing is freed: an invocation is short, and freeing
//! costs more than it saves.
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;

struct Bump;

static mut NEXT: usize = 0;
static mut END: usize = 0;

unsafe extern "C" {
    static __heap_base: u8;
}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe {
            if NEXT == 0 {
                NEXT = &raw const __heap_base as usize;
                END = wasm32::memory_size::<0>() * 65536;
            }
            let start = (NEXT + layout.align() - 1) & !(layout.align() - 1);
            let Some(end) = start.checked_add(layout.size()) else {
                return core::ptr::null_mut();
            };
            if end > END {
                let pages = (end - END).div_ceil(65536);
                if wasm32::memory_grow::<0>(pages) == usize::MAX {
                    return core::ptr::null_mut();
                }
                END += pages * 65536;
            }
            NEXT = end;
            start as *mut u8
        }
    }

    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}

#[global_allocator]
static ALLOCATOR: Bump = Bump;

/// A panic traps: the invocation fails, and every change it made is undone.
/// Revert with [`crate::host::fail`] to give a reason instead.
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}
