//! A selected application's destination scope: the prefixes its traffic
//! is carried to -- every one of them, or none.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use neoconnect_ipc::MAX_SCOPE_PREFIXES;

/// Where one selected application's traffic is carried *to*.
///
/// # Why this cannot hold a partial list
///
/// A scope only exists if every prefix handed to [`Scope::new`] parsed.
/// One unreadable entry and the constructor returns `None`, which the
/// caller turns into "this application is not scoped" -- all of its
/// traffic carried, exactly as before scopes existed.
///
/// That is not defensive tidiness, it is the safety rule. Scoping a
/// game to *some* of its publisher's address space splits the game's
/// own connections across two paths: World of Warcraft holds its Home
/// and World connections open together, and one account appearing from
/// two source addresses at the same instant is the account-sharing
/// signature that gets people banned. `docs/design/gaming-mode.md` §5.4
/// states the rule as "the client must refuse to activate a game
/// profile whose CIDR list is not prefix-complete rather than activate
/// a partial one".
///
/// The client already refuses -- `canRouteByDestination` in
/// `game-apps.ts` sends nothing unless the catalogue says the list is
/// whole. This is the second, independent refusal, and it exists
/// because the first one being wrong is a ban rather than a bug. There
/// is deliberately **no** constructor that can build a `Scope` from a
/// list it did not fully understand, so no future caller can reach for
/// one in a hurry.
///
/// # Shape, and what it costs per packet
///
/// Sorted, merged, half-open-free inclusive ranges over the integer
/// value of the address, searched by bisection. A prefix list is a set
/// of ranges and nothing about it needs a trie: 512 prefixes is nine
/// comparisons, and the two families are kept apart so an IPv4 packet
/// never touches 128-bit arithmetic.
///
/// The per-packet cost when nothing is scoped is one `is_empty` on a
/// map -- see [`Selection::destination_scope`] -- so a customer who has
/// not added a scoped game pays exactly what they paid before.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    /// Inclusive `[start, end]` ranges, sorted by start and merged, so
    /// the last range starting at or below an address is the only one
    /// that can contain it.
    v4: Vec<(u32, u32)>,
    v6: Vec<(u128, u128)>,
}

impl Scope {
    /// Builds a scope, or refuses.
    ///
    /// `None` for an empty list and `None` if **any** prefix is
    /// unreadable -- never a scope over the ones that happened to
    /// parse. See the type's own note for why that is the whole point.
    ///
    /// Also `None` past [`MAX_SCOPE_PREFIXES`], and for the same
    /// reason rather than as a resource limit: truncating a list to fit
    /// manufactures precisely the partial scope this refuses to build.
    pub fn new<I, S>(prefixes: I) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut v4: Vec<(u32, u32)> = Vec::new();
        let mut v6: Vec<(u128, u128)> = Vec::new();
        let mut seen = 0usize;
        for prefix in prefixes {
            seen += 1;
            if seen > MAX_SCOPE_PREFIXES {
                return None;
            }
            match parse_prefix(prefix.as_ref())? {
                Prefix::V4(start, end) => v4.push((start, end)),
                Prefix::V6(start, end) => v6.push((start, end)),
            }
        }
        if v4.is_empty() && v6.is_empty() {
            return None;
        }
        merge(&mut v4);
        merge(&mut v6);
        Some(Self { v4, v6 })
    }

    /// Whether this address is one the application's traffic is carried
    /// to -- or `None` when this scope cannot answer for that family.
    ///
    /// The third answer is not indecision, it is the honest reading of
    /// a v4-only prefix list being asked about an IPv6 packet. Saying
    /// "not in scope" there would be a guess, and a guess in that
    /// direction is the two-source-address failure again by a different
    /// road: the game's IPv4 goes through the tunnel while its IPv6 to
    /// the very same server goes out direct. `None` means the caller
    /// falls back to what this feature did before scopes existed, which
    /// for IPv6 is to block the packet so the application retries over
    /// IPv4 and is carried there.
    ///
    /// A scope always answers for at least one family: [`Scope::new`]
    /// refuses to build one with no prefixes at all.
    pub fn contains(&self, destination: IpAddr) -> Option<bool> {
        match destination {
            IpAddr::V4(addr) => {
                if self.v4.is_empty() {
                    return None;
                }
                Some(contains_in(&self.v4, u32::from(addr)))
            }
            IpAddr::V6(addr) => {
                if self.v6.is_empty() {
                    return None;
                }
                Some(contains_in(&self.v6, u128::from(addr)))
            }
        }
    }
}

/// One parsed prefix, as the inclusive range it covers.
enum Prefix {
    V4(u32, u32),
    V6(u128, u128),
}

/// `a.b.c.d/len`, `addr`, or an IPv6 equivalent.
///
/// A bare address is accepted as a single-host prefix because that is
/// unambiguous and a catalogue may hold one. Host bits below the prefix
/// length are **masked off** rather than refused: `10.1.2.3/8` means
/// `10.0.0.0/8` to every tool a person edits these lists with, and
/// refusing it would drop a whole publisher's scope over a piece of
/// notation everything else accepts.
///
/// Everything genuinely unreadable -- a bad length, a bad address, a
/// second slash -- returns `None`, and one `None` refuses the whole
/// scope.
fn parse_prefix(text: &str) -> Option<Prefix> {
    let text = text.trim();
    let (addr, len) = match text.split_once('/') {
        Some((addr, len)) => (addr, Some(len)),
        None => (text, None),
    };
    if let Ok(v4) = addr.parse::<Ipv4Addr>() {
        let bits = match len {
            Some(len) => len.parse::<u32>().ok().filter(|b| *b <= 32)?,
            None => 32,
        };
        let base = u32::from(v4);
        // Shifting by the full width is undefined in C and a panic in
        // debug Rust, so /0 is spelled out rather than computed.
        let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits) };
        let start = base & mask;
        return Some(Prefix::V4(start, start | !mask));
    }
    let v6 = addr.parse::<Ipv6Addr>().ok()?;
    let bits = match len {
        Some(len) => len.parse::<u32>().ok().filter(|b| *b <= 128)?,
        None => 128,
    };
    let base = u128::from(v6);
    let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits) };
    let start = base & mask;
    Some(Prefix::V6(start, start | !mask))
}

/// Sorts and merges overlapping or touching ranges.
///
/// Merging is what makes the bisection in [`contains_in`] correct and
/// not merely fast: with overlaps left in, the last range starting at
/// or below an address is not necessarily the one that contains it, and
/// the search would answer "no" for an address covered by an earlier,
/// wider prefix. Publisher lists routinely contain a `/16` and a `/24`
/// inside it, so this is the normal case rather than a corner.
fn merge<T: Ord + Copy>(ranges: &mut Vec<(T, T)>) {
    ranges.sort_unstable();
    let mut merged: Vec<(T, T)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges.drain(..) {
        match merged.last_mut() {
            // `start <= last.1` and not `<` because two prefixes can
            // abut exactly; leaving them separate is still correct here,
            // only wider than it needs to be.
            Some(last) if start <= last.1 => {
                if end > last.1 {
                    last.1 = end;
                }
            }
            _ => merged.push((start, end)),
        }
    }
    *ranges = merged;
}

/// Bisection over merged ranges. O(log n) per packet.
fn contains_in<T: Ord + Copy>(ranges: &[(T, T)], value: T) -> bool {
    match ranges.binary_search_by(|range| range.0.cmp(&value)) {
        // A range starts exactly here.
        Ok(_) => true,
        // Every range starts above it.
        Err(0) => false,
        // The one range that could contain it is the last one starting
        // at or below it, which is what merging guarantees.
        Err(next) => value <= ranges[next - 1].1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_refuses_to_exist_unless_every_prefix_parsed() {
        // The whole safety rule in one assertion. Scoping a game to the
        // prefixes that happened to parse is scoping it to a partial
        // list, and a partial list splits the game's simultaneous
        // connections across two source addresses -- the
        // account-sharing signature. There is deliberately no way to
        // build a `Scope` that holds less than it was asked to.
        assert!(Scope::new(["203.0.113.0/24", "198.51.100.0/24"]).is_some());

        for bad in [
            "203.0.113.0/33",     // a length IPv4 does not have
            "203.0.113.0/",       // no length at all
            "203.0.113.999/24",   // not an address
            "not-an-address",     //
            "203.0.113.0/24/8",   // a second slash
            "203.0.113.0/-1",     // a negative length
        ] {
            assert!(
                Scope::new(["198.51.100.0/24", bad]).is_none(),
                "one unreadable prefix ({bad}) must refuse the whole scope, \
                 never narrow it to the rest"
            );
        }

        assert!(Scope::new(Vec::<String>::new()).is_none(), "an empty list is not a scope");
    }

    #[test]
    fn a_scope_refuses_a_list_longer_than_it_will_hold() {
        // Refused rather than truncated, and that distinction is the
        // same one as above: a truncated list *is* a partial list.
        let ok: Vec<String> =
            (0..MAX_SCOPE_PREFIXES).map(|i| format!("10.{}.{}.0/24", i / 256, i % 256)).collect();
        assert!(Scope::new(&ok).is_some());

        let too_many: Vec<String> = (0..MAX_SCOPE_PREFIXES + 1)
            .map(|i| format!("10.{}.{}.0/24", i / 256, i % 256))
            .collect();
        assert!(
            Scope::new(&too_many).is_none(),
            "an over-long list must be refused whole, not cut down to fit"
        );
    }

    #[test]
    fn a_scope_answers_for_the_families_it_covers_and_no_others() {
        // The third answer is the one that matters. A v4-only list
        // asked about IPv6 must say "I cannot tell you", not "no" --
        // saying "no" would let a scoped game's IPv6 out in the clear
        // while its IPv4 went through the tunnel, which is the two
        // source addresses problem arriving by the other family.
        let v4_only = Scope::new(["203.0.113.0/24"]).expect("a scope");
        assert_eq!(v4_only.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(v4_only.contains("198.51.100.7".parse().unwrap()), Some(false));
        assert_eq!(
            v4_only.contains("2001:db8::1".parse().unwrap()),
            None,
            "a v4-only list must not claim to know anything about IPv6"
        );

        let v6_only = Scope::new(["2001:db8::/32"]).expect("a scope");
        assert_eq!(v6_only.contains("2001:db8::1".parse().unwrap()), Some(true));
        assert_eq!(v6_only.contains("2001:dead::1".parse().unwrap()), Some(false));
        assert_eq!(v6_only.contains("203.0.113.7".parse().unwrap()), None);

        let both = Scope::new(["203.0.113.0/24", "2001:db8::/32"]).expect("a scope");
        assert_eq!(both.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(both.contains("2001:db8::1".parse().unwrap()), Some(true));
        assert_eq!(both.contains("198.51.100.7".parse().unwrap()), Some(false));
        assert_eq!(both.contains("2001:dead::1".parse().unwrap()), Some(false));
    }

    #[test]
    fn overlapping_prefixes_do_not_hide_each_other() {
        // The reason `merge` exists, and the bug it prevents. A
        // publisher list routinely holds a /16 and a /24 inside it.
        // Bisection finds the last range starting at or below the
        // address, so with the /24 left sitting inside the /16 as its
        // own range, an address above the /24 but inside the /16 would
        // land on the /24, fail its end test, and be reported out of
        // scope -- a game server excluded from a list that names it.
        let scope = Scope::new(["10.0.0.0/16", "10.0.5.0/24", "10.0.2.0/24"]).expect("a scope");
        for addr in ["10.0.0.1", "10.0.2.1", "10.0.5.1", "10.0.9.1", "10.0.255.255"] {
            assert_eq!(
                scope.contains(addr.parse().unwrap()),
                Some(true),
                "{addr} is inside the /16 and must be in scope"
            );
        }
        assert_eq!(scope.contains("10.1.0.1".parse().unwrap()), Some(false));
    }

    #[test]
    fn prefix_notation_a_person_would_actually_write_is_understood() {
        // Host bits below the length are masked rather than refused.
        // `10.1.2.3/8` means `10.0.0.0/8` to every tool these lists are
        // edited with, and refusing it would drop a whole publisher's
        // scope over notation everything else accepts.
        let masked = Scope::new(["10.1.2.3/8"]).expect("host bits are masked, not refused");
        assert_eq!(masked.contains("10.9.9.9".parse().unwrap()), Some(true));
        assert_eq!(masked.contains("11.0.0.1".parse().unwrap()), Some(false));

        // A bare address is a single host.
        let host = Scope::new(["203.0.113.7"]).expect("a bare address is a /32");
        assert_eq!(host.contains("203.0.113.7".parse().unwrap()), Some(true));
        assert_eq!(host.contains("203.0.113.8".parse().unwrap()), Some(false));

        // /0 is the whole family. Spelled out rather than computed,
        // because shifting a u32 by 32 is a panic in debug Rust.
        let everything = Scope::new(["0.0.0.0/0"]).expect("a scope");
        assert_eq!(everything.contains("1.2.3.4".parse().unwrap()), Some(true));
        assert_eq!(everything.contains("255.255.255.255".parse().unwrap()), Some(true));

        // Whitespace round an entry, which a hand-edited list has.
        assert!(Scope::new([" 203.0.113.0/24 "]).is_some());
    }
}
