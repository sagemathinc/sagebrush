//! Prime-number functions for Sage mode, written from published methods:
//!
//! * `li`: the logarithmic integral li(x) and its offset form Li(x).

pub mod li;
mod li_cheb;

pub use li::{li, li_offset};
