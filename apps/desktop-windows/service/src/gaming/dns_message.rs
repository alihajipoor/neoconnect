//! Just enough DNS wire format to police the stub's front door.
//!
//! Deliberately not a DNS library. The stub relays *responses* byte for
//! byte -- it never parses one -- so the only thing it has to understand
//! is the question in an inbound query, and the only messages it ever
//! builds itself are the two refusals. That is a header, one QNAME and
//! an rcode, and a dependency for it would be more code on the machine
//! than the code it replaced.
//!
//! What this file has to get right is narrow and it is all failure
//! handling: a query the parser mis-reads is a name the allowlist waves
//! through, and the allowlist is the whole of §4.2.6 -- the difference
//! between a resolver that answers a game's hostnames and an open
//! resolver that gets the node's address blocklisted.

/// RFC 1035 §4.1.1 header, fixed size.
pub const HEADER_LEN: usize = 12;

/// RFC 1035 §2.3.4: 255 octets for a name on the wire, including the
/// length bytes and the root.
const MAX_NAME_WIRE_LEN: usize = 255;

/// Response codes we ever set ourselves.
pub const RCODE_FORMERR: u8 = 1;
pub const RCODE_SERVFAIL: u8 = 2;
pub const RCODE_REFUSED: u8 = 5;

/// The parts of a query the stub actually acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    /// The transaction id, echoed into whatever we send back. A reply
    /// carrying a different id is not an answer to anything.
    pub id: u16,
    /// QNAME, lowercased and without the trailing root dot, which is
    /// the form the allowlist compares against.
    pub name: String,
    pub qtype: u16,
    pub qclass: u16,
    /// One past the last byte of the question section, so a refusal can
    /// echo the question back verbatim rather than re-encoding it.
    pub question_end: usize,
}

/// Reads the id and the single question out of a query.
///
/// Strict on purpose. Every `Err` here becomes a FORMERR that is never
/// forwarded, and the alternative to strictness is guessing what a
/// malformed packet meant -- which, for the one component deciding what
/// may leave the machine, is guessing whether to forward it.
pub fn parse_query(packet: &[u8]) -> Result<Question, &'static str> {
    if packet.len() < HEADER_LEN {
        return Err("shorter than a DNS header");
    }
    let id = u16::from_be_bytes([packet[0], packet[1]]);
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]);
    // Exactly one. Zero means there is no name to check, and the
    // allowlist cannot approve a question that is not there. More than
    // one is not something any resolver in the wild sends and is a
    // classic way to smuggle a second name past a filter that only
    // reads the first.
    if qdcount != 1 {
        return Err("does not carry exactly one question");
    }

    let mut offset = HEADER_LEN;
    let mut name = String::new();
    let mut wire_len = 0usize;
    loop {
        let len = *packet.get(offset).ok_or("ran off the end of the name")?;
        offset += 1;
        match len & 0xC0 {
            0x00 => {}
            // A compression pointer in a *query*. There is nothing
            // earlier in the packet for it to point at -- the question
            // is the first thing after the header -- so this is either
            // a malformed packet or an attempt to make the parser
            // follow an offset. Refusing outright is also what makes
            // the loop above provably terminate.
            0xC0 => return Err("uses a compression pointer, which a query cannot"),
            _ => return Err("uses a reserved label type"),
        }
        if len == 0 {
            break;
        }
        wire_len += len as usize + 1;
        if wire_len > MAX_NAME_WIRE_LEN {
            return Err("carries an over-long name");
        }
        let end = offset
            .checked_add(len as usize)
            .ok_or("carries a label that overflows")?;
        let label = packet.get(offset..end).ok_or("ran off the end of a label")?;
        if !name.is_empty() {
            name.push('.');
        }
        // Bytes, not UTF-8: a label is arbitrary octets on the wire.
        // Anything outside the LDH set cannot match a namespace we
        // installed a rule for, so it will be refused a moment later --
        // but it must be *representable* first, or a hostile label
        // could crash the parse and become a code path of its own.
        for byte in label {
            name.push(byte.to_ascii_lowercase() as char);
        }
        offset = end;
    }
    // QTYPE and QCLASS. A query that stops before them has no question
    // in it, whatever the header claims.
    let question_end = offset + 4;
    if packet.len() < question_end {
        return Err("is truncated before the question's type and class");
    }
    let qtype = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
    let qclass = u16::from_be_bytes([packet[offset + 2], packet[offset + 3]]);

    Ok(Question {
        id,
        name,
        qtype,
        qclass,
        question_end,
    })
}

/// Builds a response carrying nothing but `rcode`, echoing the query's
/// id and its question section.
///
/// Echoing both is not politeness. A resolver client matches a reply to
/// its outstanding query by id *and* question, and one that matches
/// neither is discarded as unsolicited -- so a refusal that dropped
/// them would present to the application as no answer at all, which is
/// a timeout, which is the silence this mode must never produce.
pub fn error_response(packet: &[u8], question: Option<&Question>, rcode: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + 64);
    // Id, or zeros if the packet was too short to have one -- in which
    // case nothing is listening for this reply anyway.
    out.push(*packet.first().unwrap_or(&0));
    out.push(*packet.get(1).unwrap_or(&0));

    let flags_hi = *packet.get(2).unwrap_or(&0);
    // QR=1 (this is a response), OPCODE copied from the query, AA=0,
    // TC=0, RD copied from the query. RA=0: we do not offer recursion
    // to anyone, which is the honest answer for a stub that refuses
    // everything outside one game's namespaces.
    out.push(0x80 | (flags_hi & 0x78) | (flags_hi & 0x01));
    out.push(rcode & 0x0F);

    match question {
        Some(q) if packet.len() >= q.question_end => {
            out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
            out.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // AN/NS/AR = 0
            out.extend_from_slice(&packet[HEADER_LEN..q.question_end]);
        }
        // Nothing we could parse, so nothing to echo. A header-only
        // response with QDCOUNT=0 is well formed and says "this was not
        // a question I could read".
        _ => out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]),
    }
    out
}

/// Whether `name` falls inside the DNS suffix `namespace`.
///
/// The whole reason this is not `ends_with`. "evilblizzard.com" ends
/// with "blizzard.com" and is a completely different domain owned by
/// somebody else; approving it would hand an attacker-chosen name to
/// the proxy, which is §4.2.7's name-asserted-routing hazard reached
/// through the front door instead.
///
/// Both sides are expected lowercased, without a trailing dot and
/// without a leading dot -- [`normalise`] is what puts them in that
/// form.
pub fn matches_namespace(name: &str, namespace: &str) -> bool {
    if namespace.is_empty() {
        return false;
    }
    if name == namespace {
        return true;
    }
    match name.len().checked_sub(namespace.len()) {
        // A subdomain is the suffix preceded by a label boundary, and
        // nothing else is.
        Some(cut) if cut > 0 => name.ends_with(namespace) && name.as_bytes()[cut - 1] == b'.',
        _ => false,
    }
}

/// Puts a configured suffix or a parsed QNAME into the one form
/// [`matches_namespace`] compares: lowercase, no leading dot, no
/// trailing dot.
pub fn normalise(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// Query encoding, for tests only.
///
/// Shared with `stub`'s tests rather than duplicated, so both sides are
/// exercised against one encoder: a bug in a per-file test helper would
/// otherwise be a bug the tests agree with.
#[cfg(test)]
pub mod tests_support {
    /// Builds a query the way a resolver does, so the parser is tested
    /// against the encoding rather than against itself.
    pub fn query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
        let mut p = Vec::new();
        p.extend_from_slice(&id.to_be_bytes());
        p.extend_from_slice(&[0x01, 0x00]); // standard query, RD set
        p.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
        p.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        for label in name.split('.') {
            p.push(label.len() as u8);
            p.extend_from_slice(label.as_bytes());
        }
        p.push(0);
        p.extend_from_slice(&qtype.to_be_bytes());
        p.extend_from_slice(&1u16.to_be_bytes()); // IN
        p
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::query;
    use super::*;

    #[test]
    fn reads_the_name_out_of_an_ordinary_query() {
        let packet = query(0xBEEF, "us.actual.battle.net", 1);
        let q = parse_query(&packet).expect("an ordinary query must parse");
        assert_eq!(q.id, 0xBEEF);
        assert_eq!(q.name, "us.actual.battle.net");
        assert_eq!(q.qtype, 1);
        assert_eq!(q.qclass, 1);
        assert_eq!(q.question_end, packet.len());
    }

    #[test]
    fn lowercases_the_name_so_the_allowlist_cannot_be_dodged_by_case() {
        // DNS is case-insensitive and 0x20 randomisation makes mixed
        // case routine, so an allowlist comparing raw bytes would let
        // "BliZZard.CoM" straight past.
        let q = parse_query(&query(1, "US.Actual.BATTLE.net", 1)).unwrap();
        assert_eq!(q.name, "us.actual.battle.net");
    }

    /// A compression pointer cannot appear in a query -- the question
    /// is the first thing after the header, so there is nothing behind
    /// it to point at. Following one would mean reading the name from
    /// an offset the sender chose.
    #[test]
    fn refuses_a_compression_pointer_in_a_query() {
        let mut packet = query(1, "blizzard.com", 1);
        packet[HEADER_LEN] = 0xC0;
        packet[HEADER_LEN + 1] = 0x0C;
        assert!(parse_query(&packet).is_err());
    }

    #[test]
    fn refuses_a_reserved_label_type() {
        let mut packet = query(1, "blizzard.com", 1);
        packet[HEADER_LEN] = 0x80;
        assert!(parse_query(&packet).is_err());
    }

    #[test]
    fn refuses_a_truncated_packet() {
        let packet = query(1, "blizzard.com", 1);
        for cut in [0, 5, HEADER_LEN, HEADER_LEN + 3, packet.len() - 3] {
            assert!(
                parse_query(&packet[..cut]).is_err(),
                "a packet cut to {cut} bytes was accepted"
            );
        }
    }

    /// A label whose length byte runs past the end of the buffer. The
    /// arithmetic version of the same trap.
    #[test]
    fn refuses_a_label_longer_than_the_packet() {
        let mut packet = query(1, "blizzard.com", 1);
        packet[HEADER_LEN] = 60;
        assert!(parse_query(&packet).is_err());
    }

    #[test]
    fn refuses_a_packet_with_no_question_at_all() {
        let mut packet = query(1, "blizzard.com", 1);
        packet[4] = 0;
        packet[5] = 0;
        assert!(parse_query(&packet).is_err());
        // And more than one, which is how a second name gets smuggled
        // past a filter that reads only the first.
        packet[5] = 2;
        assert!(parse_query(&packet).is_err());
    }

    #[test]
    fn refuses_a_name_longer_than_the_wire_format_allows() {
        let long = std::iter::repeat("abcdefghij")
            .take(30)
            .collect::<Vec<_>>()
            .join(".");
        assert!(parse_query(&query(1, &long, 1)).is_err());
    }

    #[test]
    fn a_refusal_echoes_the_id_and_the_question() {
        let packet = query(0x1234, "example.com", 1);
        let q = parse_query(&packet).unwrap();
        let out = error_response(&packet, Some(&q), RCODE_REFUSED);

        assert_eq!(&out[0..2], &[0x12, 0x34], "the id must be echoed");
        assert_eq!(out[2] & 0x80, 0x80, "QR must say this is a response");
        assert_eq!(out[2] & 0x01, 0x01, "RD is copied from the query");
        assert_eq!(out[3] & 0x0F, RCODE_REFUSED);
        assert_eq!(u16::from_be_bytes([out[4], out[5]]), 1, "QDCOUNT");
        assert_eq!(&out[6..12], &[0, 0, 0, 0, 0, 0], "no records of any kind");
        assert_eq!(
            &out[HEADER_LEN..],
            &packet[HEADER_LEN..],
            "the question must come back verbatim"
        );
        // And it must parse as a message in its own right.
        assert_eq!(parse_query(&out).unwrap().name, "example.com");
    }

    #[test]
    fn a_servfail_echoes_the_id_and_the_question_too() {
        let packet = query(0xABCD, "blizzard.com", 28);
        let q = parse_query(&packet).unwrap();
        let out = error_response(&packet, Some(&q), RCODE_SERVFAIL);
        assert_eq!(&out[0..2], &[0xAB, 0xCD]);
        assert_eq!(out[3] & 0x0F, RCODE_SERVFAIL);
        assert_eq!(&out[HEADER_LEN..], &packet[HEADER_LEN..]);
    }

    /// Nothing parseable still has to produce something well formed,
    /// because the alternative is silence and silence reads to the
    /// application as a timeout.
    #[test]
    fn an_unreadable_packet_still_gets_a_well_formed_reply() {
        let out = error_response(&[0x55, 0x66, 0x01, 0x00], None, RCODE_FORMERR);
        assert_eq!(out.len(), HEADER_LEN);
        assert_eq!(&out[0..2], &[0x55, 0x66]);
        assert_eq!(out[3] & 0x0F, RCODE_FORMERR);
        assert_eq!(u16::from_be_bytes([out[4], out[5]]), 0, "QDCOUNT is zero");
    }

    #[test]
    fn a_name_matches_its_own_namespace_and_its_subdomains() {
        assert!(matches_namespace("blizzard.com", "blizzard.com"));
        assert!(matches_namespace("eu.actual.battle.net", "battle.net"));
        assert!(matches_namespace("a.b.c.blizzard.com", "blizzard.com"));
    }

    /// The bug an `ends_with` would ship. A different domain that
    /// happens to end with the suffix string is somebody else's, and
    /// forwarding it is §4.2.7 -- an attacker naming the host the proxy
    /// connects to.
    #[test]
    fn a_name_that_merely_ends_with_the_suffix_does_not_match() {
        assert!(!matches_namespace("evilblizzard.com", "blizzard.com"));
        assert!(!matches_namespace("notbattle.net", "battle.net"));
        assert!(!matches_namespace("xbattle.net", "battle.net"));
    }

    #[test]
    fn a_shorter_or_unrelated_name_does_not_match() {
        assert!(!matches_namespace("com", "blizzard.com"));
        assert!(!matches_namespace("", "blizzard.com"));
        assert!(!matches_namespace("example.org", "blizzard.com"));
        assert!(!matches_namespace("blizzard.com", ""));
    }

    #[test]
    fn normalisation_puts_both_sides_in_the_same_form() {
        assert_eq!(normalise(".Blizzard.Com."), "blizzard.com");
        assert_eq!(normalise("  battle.net  "), "battle.net");
        assert_eq!(normalise("."), "");
    }
}
