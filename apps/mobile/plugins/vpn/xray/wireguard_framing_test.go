//go:build darwin

package neoxifyxray

import (
	"bytes"
	"testing"

	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/tun"
)

// The utun framing, which is the only part of the iOS WireGuard path
// that can be exercised without an iPhone -- and the part where being
// subtly wrong is survivable enough to go unnoticed. A read that
// mis-slices by four bytes still carries small packets; it corrupts
// large ones. A write with the wrong address family is dropped by the
// kernel without a word, which presents as a tunnel that connects and
// carries nothing.

func newTestTUN(rw *bytes.Buffer) *iosTUN {
	return &iosTUN{io: rw, name: "utun9", mtu: 1420, events: make(chan tun.Event, 4)}
}

// wireguard-go hands Read a buffer with headroom and expects the packet
// at `offset`. The four-byte utun header has to land in that headroom
// and be excluded from the reported size -- not copied, not counted.
func TestReadStripsTheUtunHeader(t *testing.T) {
	packet := []byte{0x45, 0x00, 0x00, 0x1c, 0xde, 0xad, 0xbe, 0xef}
	framed := append([]byte{0, 0, 0, unix.AF_INET}, packet...)

	device := newTestTUN(bytes.NewBuffer(framed))
	const offset = 16
	bufs := [][]byte{make([]byte, offset+len(packet)+64)}
	sizes := make([]int, 1)

	n, err := device.Read(bufs, sizes, offset)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if n != 1 {
		t.Fatalf("read %d packets, want 1", n)
	}
	if sizes[0] != len(packet) {
		t.Fatalf("reported size %d, want %d -- the header is being counted", sizes[0], len(packet))
	}
	if got := bufs[0][offset : offset+sizes[0]]; !bytes.Equal(got, packet) {
		t.Fatalf("packet at offset = % x, want % x", got, packet)
	}
}

// A read that returns only the header, or less, is not a zero-length
// packet -- it is a broken descriptor. Reporting it as a packet would
// have wireguard-go process four bytes of nothing.
func TestReadRejectsATruncatedFrame(t *testing.T) {
	device := newTestTUN(bytes.NewBuffer([]byte{0, 0, 0}))
	bufs := [][]byte{make([]byte, 128)}
	if _, err := device.Read(bufs, make([]int, 1), 16); err == nil {
		t.Fatal("a three-byte read was accepted; it cannot contain a packet")
	}
}

// The family byte is not inferred by the kernel. Getting it wrong is
// silent, so both versions are pinned here.
func TestWriteTagsTheAddressFamily(t *testing.T) {
	for _, tc := range []struct {
		name    string
		version byte
		family  byte
	}{
		{"IPv4", 0x40, unix.AF_INET},
		{"IPv6", 0x60, unix.AF_INET6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := &bytes.Buffer{}
			device := newTestTUN(out)

			const offset = 4
			buf := make([]byte, offset+4)
			buf[offset] = tc.version
			copy(buf[offset+1:], []byte{0x11, 0x22, 0x33})

			n, err := device.Write([][]byte{buf}, offset)
			if err != nil {
				t.Fatalf("Write: %v", err)
			}
			if n != 1 {
				t.Fatalf("wrote %d packets, want 1", n)
			}
			written := out.Bytes()
			if want := []byte{0, 0, 0, tc.family}; !bytes.Equal(written[:4], want) {
				t.Fatalf("header = % x, want % x", written[:4], want)
			}
			if written[4] != tc.version {
				t.Fatalf("packet body starts %#x, want %#x -- the header overwrote it", written[4], tc.version)
			}
		})
	}
}

// Neither IPv4 nor IPv6. Writing it with a guessed family would have the
// kernel discard it anyway, so the only honest outcome is to skip it and
// not count it as written.
func TestWriteSkipsWhatItCannotTag(t *testing.T) {
	out := &bytes.Buffer{}
	device := newTestTUN(out)

	buf := make([]byte, 8)
	buf[4] = 0x90 // version 9

	n, err := device.Write([][]byte{buf}, 4)
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != 0 {
		t.Fatalf("counted %d packets written, want 0", n)
	}
	if out.Len() != 0 {
		t.Fatalf("wrote % x, want nothing", out.Bytes())
	}
}

// Both directions need four bytes of headroom. Without the guard the
// slice expression underflows and panics inside the tunnel, where the
// crash is attributed to the extension rather than to the caller.
func TestOffsetsTooSmallAreRefused(t *testing.T) {
	device := newTestTUN(&bytes.Buffer{})
	if _, err := device.Read([][]byte{make([]byte, 64)}, make([]int, 1), 3); err == nil {
		t.Fatal("Read accepted an offset of 3")
	}
	if _, err := device.Write([][]byte{make([]byte, 64)}, 3); err == nil {
		t.Fatal("Write accepted an offset of 3")
	}
}

// Batching more than one would have wireguard-go allocate buffers this
// device can never fill: a utun descriptor carries one packet per read.
func TestBatchSizeIsOne(t *testing.T) {
	if got := newTestTUN(&bytes.Buffer{}).BatchSize(); got != 1 {
		t.Fatalf("BatchSize() = %d, want 1", got)
	}
}
