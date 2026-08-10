# Android 0.2.8, real-device findings

Reported from a real phone on 2026-08-10, after 0.2.8 shipped. Written
down because the emulator did not show most of these, and two of them
are regressions from fixes made the same day.

## 1. Latency goes wrong after the first connect, and stays wrong

**Observed:** 150-170ms per server before connecting to anything, which
is right. After connecting to any protocol and then disconnecting, every
server reads under 5ms and stays there.

**Cause:** the probe now runs through the tunnel. Removing the app's
self-exclusion from its own VpnService was necessary -- it is what
stopped the egress check condemning working tunnels -- but it also put
`measure_latency` inside the tunnel, where a TCP connect to the node it
is tunnelling through is nearly instant. Those readings are then cached
and survive the disconnect.

**Not** a QEMU artefact. That was the earlier guess, made because the
emulator was only ever measured after a connect. The user's pre-connect
numbers disprove it.

**Fix:** do not measure while connected -- the number is meaningless
through a tunnel -- and invalidate the cache whenever connection state
changes, so the next open re-measures from the plain route.

## 2. A stuck connect cannot be cancelled

**Observed:** when a protocol hangs in "checking connection", pressing
the button again does nothing. The customer waits out the timeout.

**Fix:** the button must abort the in-flight attempt while verifying,
not only disconnect an established tunnel.

## 3. "Compatible" fails over to Fast instead of saying it cannot be used

OpenVPN is not supported on Android at all. Picking it should say so up
front -- the unsupported-choice notice exists for this -- rather than
appearing to try and then landing on Fast.

## 4. Protocols behave inconsistently between nodes

**Observed:** Finland Shadowsocks failed over to Fast; France
Shadowsocks connected. Others sometimes hang in "checking connection",
sometimes fall back.

Both Shadowsocks inbounds were checked and are identical in shape: same
cipher (2022-blake3-aes-256-gcm), one seed client each, both listening
(fi1 on 41820, fr1 on 37651). So this is not a missing inbound, and the
difference is at connect time rather than in the node config.

## What the next session should do

Run the full matrix on the emulator: **every protocol on every node**,
14 routes. For each one record

- what the app said (connected / failed over / hung)
- whether the node's own access log shows the session arriving
- the exit IP the app reported

The node log is the part that settles it. For Stealth HTTPS the app said
"not carrying traffic" while fi1's log showed that exact session
proxying DNS and TCP -- the tunnel was fine and the verdict was wrong.
Any protocol that "fails" needs the same check before believing the app.
