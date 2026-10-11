#![no_std]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! { loop {} }
macro_rules! f1 { ($($n:ident),*) => { $( #[no_mangle] pub extern "C" fn $n(x: f64) -> f64 { libm::$n(x) } )* } }
macro_rules! f2 { ($($n:ident),*) => { $( #[no_mangle] pub extern "C" fn $n(x: f64, y: f64) -> f64 { libm::$n(x, y) } )* } }
f1!(sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, asinh, acosh, atanh, exp, expm1, log, log2, log10, log1p, cbrt);
f2!(atan2, hypot, pow);
