//! The thin Windows layer Custom mode stands on.
//!
//! Wrappers, not policy: the WinDivert handle the intercept loop reads
//! packets through, the firewall allowance that lets the stack deliver
//! what it rewrites, and the pin that puts a socket on the tunnel.
//! Nothing in here decides which packet goes where -- that is `policy`
//! and `intercept` -- so everything in here can be read as "what Windows
//! is asked to do", and nothing else.

pub(super) mod divert;
pub(crate) mod firewall;
pub(super) mod pin;
