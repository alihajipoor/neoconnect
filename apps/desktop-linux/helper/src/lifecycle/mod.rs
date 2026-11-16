//! The session's lifecycle, independent of what a tunnel is.
//!
//! `supervisor`, `cancel` and `budget` are the Windows service's own files
//! (`apps/desktop-windows/service/src/lifecycle`), copied with their
//! comments because every rule in them was paid for by a customer-facing
//! fault there; their Windows history is kept as the reason. `teardown`,
//! `ledger`, `idle` and `client_watch` keep the Windows logic and change
//! only what Linux must.

// Copied whole, so that the rules stay recognisably the Windows ones; not
// every item is used on Linux.
#[allow(dead_code)]
pub mod budget;
#[allow(dead_code)]
pub mod cancel;
pub mod client_watch;
pub mod idle;
pub mod ledger;
pub mod supervisor;
pub mod teardown;
