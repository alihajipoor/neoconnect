#!/usr/bin/env python3
"""probe.py <address> <port> [bytes]

The other half of the bare-box test (see node/sink.py): runs on a box
inside the watched country. Uploads N bytes (256 KB unless told
otherwise) to the sink, reads back how many arrived, then downloads the
same number. Prints one line and never the address:

    <port> PASS up 262144/262144 0.34s down 262144/262144 0.31s
    <port> HELD up 98304/262144 8.00s down 0/262144 0.00s
    <port> CLOSED (no connection)

PASS means both directions moved everything inside the time limit. HELD
is the result that matters: the connection opened and the bytes stopped.
It holds nothing and writes nothing.
"""
import socket
import struct
import sys
import time

addr, port = sys.argv[1], int(sys.argv[2])
size = int(sys.argv[3]) if len(sys.argv) > 3 else 262144
LEG = 8.0


def main():
    try:
        s = socket.create_connection((addr, port), timeout=5)
    except OSError:
        return "%d CLOSED (no connection)" % port
    up = down = acked = 0
    t_up = t_down = 0.0
    try:
        s.settimeout(LEG)
        start = time.time()
        s.sendall(struct.pack(">I", size))
        body = b"\xa5" * 16384
        try:
            while up < size and time.time() - start < LEG:
                s.settimeout(max(0.1, LEG - (time.time() - start)))
                up += s.send(body[: min(len(body), size - up)])
            s.settimeout(max(0.1, LEG - (time.time() - start)))
            head = b""
            while len(head) < 4:
                chunk = s.recv(4 - len(head))
                if not chunk:
                    break
                head += chunk
            if len(head) == 4:
                acked = struct.unpack(">I", head)[0]
        except OSError:
            pass
        t_up = time.time() - start
        start = time.time()
        try:
            while down < acked and time.time() - start < LEG:
                s.settimeout(max(0.1, LEG - (time.time() - start)))
                chunk = s.recv(65536)
                if not chunk:
                    break
                down += len(chunk)
        except OSError:
            pass
        t_down = time.time() - start
    finally:
        s.close()
    # What the far side says it received is what counts for the upload:
    # the kernel accepts bytes into its buffer long after the path stalls.
    verdict = "PASS" if acked == size and down == size else "HELD"
    return "%d %s up %d/%d %.2fs down %d/%d %.2fs" % (port, verdict, acked, size, t_up, down, size, t_down)


print(main())
