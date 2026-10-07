//! The thin Windows layer Custom mode stands on.
//!
//! Wrappers, not policy: the WinDivert handle the intercept loop reads
//! packets through, and the firewall allowance that lets the stack
//! deliver what it rewrites. Nothing in here decides which packet goes
//! where -- that is `policy` and `intercept` -- so everything in here can
//! be read as "what Windows is asked to do", and nothing else.

pub(super) mod divert;
pub(crate) mod firewall;
