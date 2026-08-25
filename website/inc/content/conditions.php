<?php
/**
 * Network conditions for the home page's interactive panel.
 *
 * Each entry is a kind of blocking a filtered network actually does. Switch
 * one on and the panel strikes out the connection methods it stops, then
 * shows which method the app would fall back to.
 *
 * ============================================================================
 *  WHAT THIS PANEL IS, AND WHAT IT IS NOT.
 *
 *  It is an ILLUSTRATION of how the client chooses a transport. It is NOT a
 *  live probe of the fleet, and the copy beside it says so in both locales
 *  (see `home.inst.note`). Nothing here contacts a server, measures a route,
 *  or reports the state of anything.
 *
 *  That distinction is a product requirement, not a nicety. This site's
 *  whole posture is that it never reports a connection state it has not
 *  verified -- users on filtered networks act on what we tell them. A
 *  widget that *looked* like a live status board while being a scripted
 *  animation would be the exact failure the rest of the codebase exists to
 *  avoid, so it must keep reading as a demonstration.
 *
 *  WHAT IS TRACEABLE HERE: the mapping from a condition to the methods it
 *  kills. These are properties of how each transport looks on the wire and
 *  can be reasoned about from public documentation:
 *
 *    - `udp` stops WireGuard and IKEv2 because both are UDP. OpenVPN
 *      degrades rather than dies, because it can fall back to TCP.
 *    - `sni` stops plain TLS transports, because the hostname travels in
 *      clear text in the ClientHello.
 *    - `ja3` stops transports identifiable by TLS fingerprint.
 *    - `dpi` stops protocols with a recognisable handshake.
 *    - `port` stops anything pinned to a non-web port.
 *    - REALITY survives all of the above, which is precisely what it was
 *      built to do.
 *
 *  NO CONDITION CLAIMS A SUCCESS RATE, and none ever should. "Stealth
 *  survives DPI" is a statement about protocol design; "Stealth works 98%
 *  of the time in Iran" would be a measurement nobody has taken.
 * ============================================================================
 *
 * Fields:
 *   id        matches the `blocked_by` ids in inc/content/protocols.php,
 *             and the `cond.<id>.label` / `.sub` translation keys
 *   relay     true when the condition is answered by the Iran relay rather
 *             than by switching transport
 *   total     true for the one condition that is not filtering at all --
 *             the network being switched off. Renders inverted rather than
 *             red, because nothing routes around it and the panel must say
 *             so rather than pretending otherwise.
 */

defined('NX') || exit;

return array(

    array('id' => 'dpi'),
    array('id' => 'udp'),
    array('id' => 'sni'),
    array('id' => 'ja3'),
    array('id' => 'port'),

    /* Not a filter: a domestic-only network, where the answer is the relay
       rather than a different transport. */
    array('id' => 'dc', 'relay' => true),

    /* A full shutdown. Nothing survives it, the panel says exactly that,
       and no plan or protocol is offered as an answer -- because there
       isn't one. */
    array('id' => 'off', 'total' => true),
);
