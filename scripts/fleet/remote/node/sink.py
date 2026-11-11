#!/usr/bin/env python3
"""sink.py <port> <seconds>

A byte sink for the bare-box test: runs on a box that has nothing
installed yet. For each connection it reads a 4-byte length, reads that
many bytes, answers with how many arrived, then sends the same number
back. It holds nothing, logs counts only, and exits by itself.

The point is to see a hold, not a block: a filtered address range often
lets the connection open and then stalls the upload after 60-150 KB. A
TCP connect, or a small request, passes on such a range.
"""
import socket
import struct
import sys
import threading
import time

port = int(sys.argv[1])
deadline = time.time() + int(sys.argv[2])
LIMIT = 1 << 20


def serve(conn):
    got = 0
    try:
        conn.settimeout(20)
        head = b""
        while len(head) < 4:
            chunk = conn.recv(4 - len(head))
            if not chunk:
                return
            head += chunk
        want = min(struct.unpack(">I", head)[0], LIMIT)
        while got < want:
            chunk = conn.recv(min(65536, want - got))
            if not chunk:
                break
            got += len(chunk)
        conn.sendall(struct.pack(">I", got))
        conn.sendall(b"\0" * got)
    except OSError:
        pass
    finally:
        print("port %d: received %d bytes" % (port, got), flush=True)
        conn.close()


srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", port))
srv.listen(8)
srv.settimeout(2)
while time.time() < deadline:
    try:
        c, _ = srv.accept()
    except socket.timeout:
        continue
    threading.Thread(target=serve, args=(c,), daemon=True).start()
