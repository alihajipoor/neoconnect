#!/usr/bin/env python3
"""Both ends of the packets in netns-proof.sh.

serve HOST...:  listens on TCP 53, 80 and 443 (IPv4 and IPv6 alike) and on
        UDP 53 at each HOST, and answers anything it gets.
probe:  probe tcp|udp HOST PORT [MARK] -- prints "pass" or "refused" and
        how long it took, exits 0 or 1. MARK sets SO_MARK, which is how the
        WireGuard engine marks its own packets.
stream HOST PORT SECONDS: sends UDP datagrams to HOST:PORT without pause
        for SECONDS, whatever the sends answer, and prints how many it tried.
count HOST PORT SECONDS: counts the datagrams that arrive at HOST:PORT in
        SECONDS and prints the number: what got past the rules, counted on
        the far side rather than by the sender.
"""
import socket
import sys
import threading
import time

SO_MARK = 36


def serve_tcp(port):
    s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    s.bind(("::", port))
    s.listen(64)
    while True:
        c, _ = s.accept()
        try:
            c.sendall(b"hi\n")
        finally:
            c.close()


def serve_udp(host, port):
    # One socket per address: a socket bound to the wildcard answers from
    # whatever source the route back picks, which for an address on lo or
    # a second link-local one is not the address that was asked, and the
    # prober's connected socket rightly ignores the answer.
    family, _, _, _, addr = socket.getaddrinfo(host, port, type=socket.SOCK_DGRAM)[0]
    s = socket.socket(family, socket.SOCK_DGRAM)
    s.bind(addr)
    while True:
        data, peer = s.recvfrom(2048)
        s.sendto(data, peer)


def serve(udp_hosts):
    threads = [threading.Thread(target=serve_tcp, args=(p,), daemon=True) for p in (53, 80, 443)]
    threads += [threading.Thread(target=serve_udp, args=(h, 53), daemon=True) for h in udp_hosts]
    for t in threads:
        t.start()
    print("serving", flush=True)
    while True:
        time.sleep(3600)


def probe(kind, host, port, mark=None):
    started = time.monotonic()
    stype = socket.SOCK_STREAM if kind == "tcp" else socket.SOCK_DGRAM
    family, _, _, _, addr = socket.getaddrinfo(host, int(port), type=stype)[0]
    s = socket.socket(family, stype)
    s.settimeout(2)
    if mark is not None:
        s.setsockopt(socket.SOL_SOCKET, SO_MARK, int(mark))
    why = "wrong answer"
    try:
        s.connect(addr)
        if kind == "tcp":
            ok = s.recv(16).startswith(b"hi")
        else:
            s.send(b"ping")
            ok = s.recv(16) == b"ping"
    except OSError as e:
        ok = False
        why = e.__class__.__name__
    ms = int((time.monotonic() - started) * 1000)
    print(("pass" if ok else "refused ({})".format(why)) + " in {} ms".format(ms))
    return 0 if ok else 1


def stream(host, port, seconds):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    end = time.monotonic() + float(seconds)
    tried = 0
    while time.monotonic() < end:
        tried += 1
        try:
            s.sendto(b"x", (host, int(port)))
        except OSError:
            # A refusal answers the send itself; the next one goes anyway.
            pass
        time.sleep(0.0002)
    print(tried)
    return 0


def count(host, port, seconds):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((host, int(port)))
    end = time.monotonic() + float(seconds)
    got = 0
    while True:
        left = end - time.monotonic()
        if left <= 0:
            break
        s.settimeout(left)
        try:
            s.recv(64)
            got += 1
        except socket.timeout:
            break
    print(got, flush=True)
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve(sys.argv[2:])
    elif sys.argv[1] == "stream":
        sys.exit(stream(*sys.argv[2:]))
    elif sys.argv[1] == "count":
        sys.exit(count(*sys.argv[2:]))
    else:
        sys.exit(probe(*sys.argv[2:]))
