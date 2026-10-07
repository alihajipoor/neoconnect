//! The concurrent exits a session's engine offers, by index.

use std::sync::Mutex;

/// The concurrent exits the running engine is offering, and the
/// loopback SOCKS5 port that reaches each.
///
/// # Why this is not a second `TunnelInterface`
///
/// [`TunnelInterface`](crate::split_tunnel::net::pin::TunnelInterface)
/// names *an adapter*. There is one adapter, one
/// address on it, and one default route at one metric -- every one of
/// those a singleton that `docs/design/per-game-exits.md` §2.3 lists as
/// blocking a second engine. Nothing here is an adapter. Each entry is
/// a port on loopback that the one running Xray process is listening
/// on, and Xray's own routing table is what turns a port into a node.
/// So this table can hold three exits while the machine still has one
/// tunnel adapter, one route and one janitor.
///
/// # Why the table is fixed for the life of a session
///
/// [`crate::split_tunnel::flows::Origin`] stores an *index* into this table rather
/// than the exit's name, because `Origin` is `Copy` and is stored per
/// live flow. An index is only meaningful against the table it was
/// taken from, so the table is written when an engine starts and
/// cleared when it stops, and never edited in between. Changing a
/// customer's *preferences* mid-session does not touch it: preferences
/// live on [`crate::split_tunnel::policy::Selection`] and say which exit an
/// application wants, while this says which exits exist. The two are
/// separately mutable precisely so that the index a flow is holding
/// cannot come to mean a different node underneath it.
#[derive(Default)]
pub struct ExitRelays {
    /// Exit identifier -> loopback port, in the order the engine
    /// created the inbounds, which is the order the indices count in.
    table: Mutex<Vec<(String, u16)>>,
}

impl ExitRelays {
    /// Records the exits an engine has just brought up.
    ///
    /// Truncated to [`neoconnect_ipc::MAX_CONCURRENT_EXITS`] rather
    /// than refused. This is the last of the three places that ceiling
    /// is enforced and the only one on the packet path's side of the
    /// pipe; by the time a table is being written the customer's
    /// engine is already up, so refusing here would mean a live
    /// session with no exits at all instead of a live session with the
    /// three it is allowed.
    pub fn set(&self, exits: Vec<(String, u16)>) {
        let mut table = self.table.lock().unwrap();
        *table = exits;
        table.truncate(neoconnect_ipc::MAX_CONCURRENT_EXITS);
    }

    /// Forgets them, which is the fail-open state: every flow goes back
    /// to the one tunnel adapter.
    pub fn clear(&self) {
        self.table.lock().unwrap().clear();
    }

    /// Whether any concurrent exit is live. The packet path asks this
    /// first so that a session with none -- overwhelmingly the common
    /// case -- costs one atomic-free length check and nothing else.
    pub fn is_empty(&self) -> bool {
        self.table.lock().unwrap().is_empty()
    }

    /// The index an exit identifier occupies, if the engine brought it
    /// up.
    ///
    /// `None` for an identifier the engine does not have, and that is
    /// the fail-open case rather than an error: the application is
    /// carried on the session's own exit and reported as
    /// `ExitPlacement::Fallback`. A game that keeps working from the
    /// wrong address beats a game that stops.
    pub fn index_of(&self, exit: &str) -> Option<u8> {
        let table = self.table.lock().unwrap();
        table
            .iter()
            .position(|(name, _)| name == exit)
            // The ceiling is 3, so a `u8` cannot truncate; the cast is
            // safe by the same invariant `set` maintains.
            .map(|i| i as u8)
    }

    /// The loopback port at an index.
    pub fn port_at(&self, index: u8) -> Option<u16> {
        self.table.lock().unwrap().get(index as usize).map(|(_, port)| *port)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_exit_table_is_the_fail_open_state() {
        let exits = ExitRelays::default();
        assert!(exits.is_empty());
        assert_eq!(exits.index_of("germany-1"), None);
        assert_eq!(exits.port_at(0), None);
    }

    #[test]
    fn an_exit_resolves_to_the_port_its_inbound_listens_on() {
        let exits = ExitRelays::default();
        exits.set(vec![("turkey-1".into(), 41080), ("germany-1".into(), 41081)]);
        assert_eq!(exits.index_of("turkey-1"), Some(0));
        assert_eq!(exits.index_of("germany-1"), Some(1));
        assert_eq!(exits.port_at(0), Some(41080));
        assert_eq!(exits.port_at(1), Some(41081));
    }

    /// An identifier the engine did not bring up is `None`, which is
    /// the fail-open case: the flow takes the session's own exit rather
    /// than the first entry in the table.
    ///
    /// Answering with index 0 would be the ban signature -- one game
    /// silently sent to another game's node.
    #[test]
    fn an_unknown_exit_resolves_to_nothing_rather_than_to_the_first() {
        let exits = ExitRelays::default();
        exits.set(vec![("turkey-1".into(), 41080)]);
        assert_eq!(exits.index_of("germany-1"), None);
    }

    /// The last of the three places the ceiling is applied. By the time
    /// a table is written the engine is already up, so refusing here
    /// would mean a live session with no exits rather than a live
    /// session with the three it is allowed.
    #[test]
    fn the_exit_table_never_holds_more_than_the_ceiling() {
        let exits = ExitRelays::default();
        exits.set(vec![
            ("a".into(), 1),
            ("b".into(), 2),
            ("c".into(), 3),
            ("d".into(), 4),
            ("e".into(), 5),
        ]);
        assert_eq!(exits.index_of("c"), Some(2));
        assert_eq!(
            exits.index_of("d"),
            None,
            "past the ceiling, and falling back is the only honest answer"
        );
        assert_eq!(exits.port_at(neoconnect_ipc::MAX_CONCURRENT_EXITS as u8), None);
    }

    /// Clearing must move every game back to the session's exit in one
    /// step. A table that emptied one entry at a time would move a
    /// game's binaries at different moments, which is the two-source-
    /// address signature the whole feature is shaped around.
    #[test]
    fn clearing_the_table_takes_every_exit_at_once() {
        let exits = ExitRelays::default();
        exits.set(vec![("turkey-1".into(), 41080), ("germany-1".into(), 41081)]);
        exits.clear();
        assert!(exits.is_empty());
        assert_eq!(exits.index_of("turkey-1"), None);
        assert_eq!(exits.index_of("germany-1"), None);
    }
}
