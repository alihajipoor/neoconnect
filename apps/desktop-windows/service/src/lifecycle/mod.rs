//! The pieces the service's lifetime is built from.
//!
//! Separated from `engines` on purpose. Everything here is about *when*
//! work stops -- a client going away, an operation being cancelled, a
//! mutation being undone -- and nothing here knows what a tunnel is.
//! The old service mixed the two, which is how the split tunnel came to
//! hold the engine lock for thirty-eight seconds with nothing able to
//! interrupt it.
//!
//! See docs/windows-service-rewrite.md.

pub mod client_watch;
