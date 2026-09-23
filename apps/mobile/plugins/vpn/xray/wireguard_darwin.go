//go:build darwin

// WireGuard for iOS, in the same package and the same framework as the
// Xray engine.
//
// Same package on purpose. gomobile bakes a complete Go runtime into
// every framework it produces, so two frameworks would mean two
// runtimes, two schedulers and two heaps linked into one extension --
// which does not work and fails in ways that do not name the cause.
// One module, one runtime, both engines.
//
// It also costs almost nothing in size: xray-core already depends on
// wireguard-go's device, tun and conn packages for its own WireGuard
// outbound, so the code is in the binary either way. What is added here
// is the wiring, not the implementation.
//
// Android is deliberately excluded by the build tag. There WireGuard
// comes from `com.wireguard.android:tunnel`, which ships its own
// GoBackend and its own VpnService, and duplicating it into the AAR
// would grow every APK for nothing.
//
// The constraint is `darwin`, not `ios`, which is wider than the only
// platform this ships to. gomobile builds iOS as GOOS=ios and ios
// implies darwin, so what ships is identical -- but GOOS=ios binaries
// cannot be run on a Mac, and darwin lets the utun framing below be
// exercised by `go test` on the build machine. That framing is the one
// part of this testable at all without an iPhone, and the part most
// worth testing.
//
// It is in the filename as well as the //go:build line, and it has to
// be. Go constrains by filename suffix first: while this was called
// wireguard_ios.go it was excluded from every non-ios build regardless
// of what its build tag said, and the tests could not see it.
package neoxifyxray

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"golang.org/x/sys/unix"
	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun"
)

// A TUN device that does nothing the iOS sandbox forbids.
//
// wireguard-go's own darwin device cannot be used here, and the reason
// is not obvious from its name. `tun.CreateTUNFromFile` opens an
// AF_ROUTE raw socket to watch for interface changes and sets the MTU
// with an ioctl on an AF_INET socket. Both are denied to an app
// extension, so the constructor fails before WireGuard has started --
// and it fails at the socket, reporting an error about permissions that
// says nothing about routing. wireguard-apple does not use it either.
//
// Everything else is the reference implementation's behaviour, kept
// deliberately close to it: the utun framing below is easy to get
// subtly wrong, and a wrong version passes small packets and corrupts
// large ones.
type iosTUN struct {
	// The descriptor, and separately the thing read and written.
	// `File()` is part of tun.Device and has to hand back a real
	// *os.File, but the framing is the interesting half and a test
	// cannot supply a utun descriptor -- so the I/O goes through an
	// interface that a buffer can satisfy.
	file   *os.File
	io     io.ReadWriter
	name   string
	mtu    int
	events chan tun.Event
	once   sync.Once
}

func (t *iosTUN) File() *os.File           { return t.file }
func (t *iosTUN) Name() (string, error)    { return t.name, nil }
func (t *iosTUN) Events() <-chan tun.Event { return t.events }

// Reported, not measured. The real MTU is whatever
// NEPacketTunnelNetworkSettings was given on the Swift side, and asking
// the kernel for it needs the ioctl that is unavailable here -- so the
// caller passes what it set.
func (t *iosTUN) MTU() (int, error) { return t.mtu, nil }

// One. A utun file descriptor carries a single packet per read, so
// claiming more would have wireguard-go allocate batch buffers it can
// never fill.
func (t *iosTUN) BatchSize() int { return 1 }

// utun prefixes every packet with a four-byte address family. Reading
// into `offset-4` puts that header immediately before the packet, where
// wireguard-go's own headroom absorbs it, and the reported size excludes
// it.
func (t *iosTUN) Read(bufs [][]byte, sizes []int, offset int) (int, error) {
	if offset < 4 {
		return 0, errors.New("neoxify: read offset must leave room for the utun header")
	}
	n, err := t.io.Read(bufs[0][offset-4:])
	if err != nil {
		return 0, err
	}
	if n < 4 {
		return 0, errors.New("neoxify: short read from the tunnel")
	}
	sizes[0] = n - 4
	return 1, nil
}

// The same header on the way out, and it has to say which family the
// packet is. The kernel does not infer it: a packet written with the
// wrong family is dropped silently, which presents as a tunnel that
// connects and carries nothing.
func (t *iosTUN) Write(bufs [][]byte, offset int) (int, error) {
	if offset < 4 {
		return 0, errors.New("neoxify: write offset must leave room for the utun header")
	}
	written := 0
	for _, buf := range bufs {
		packet := buf[offset:]
		if len(packet) == 0 {
			continue
		}
		framed := buf[offset-4:]
		framed[0], framed[1], framed[2] = 0, 0, 0
		switch packet[0] >> 4 {
		case 4:
			framed[3] = unix.AF_INET
		case 6:
			framed[3] = unix.AF_INET6
		default:
			// Neither IPv4 nor IPv6. Dropped rather than guessed:
			// writing it with a made-up family would have the kernel
			// discard it anyway, without the count being honest.
			continue
		}
		if _, err := t.io.Write(framed); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

func (t *iosTUN) Close() error {
	var err error
	t.once.Do(func() {
		close(t.events)
		err = t.file.Close()
	})
	return err
}

// The interface name behind a utun descriptor.
//
// getsockopt on a socket we already own, which the sandbox permits --
// unlike the route socket the reference implementation reaches for. The
// same call the Swift side makes to find the descriptor in the first
// place.
//
// The two constants are written out because x/sys/unix does not define
// them for darwin. They are SYSPROTO_CONTROL and UTUN_OPT_IFNAME from
// <sys/kern_control.h> and <net/if_utun.h>, and the Swift side of this
// tunnel hardcodes the same pair for the same reason.
const (
	sysprotoControl = 2
	utunOptIfname   = 2
)

func utunName(fd int) (string, error) {
	name, err := unix.GetsockoptString(fd, sysprotoControl, utunOptIfname)
	if err != nil {
		return "", fmt.Errorf("neoxify: not a utun descriptor: %w", err)
	}
	return name, nil
}

var (
	wgMu     sync.Mutex
	wgDevice *device.Device
)

// WireGuardStart brings up a WireGuard tunnel on an established TUN
// descriptor.
//
// `uapiConfig` is wireguard-go's own cross-platform configuration
// format -- the same text `wg setconf` speaks -- built on the Swift
// side from the profile the backend issued. It is not wg-quick's ini
// file: addresses, DNS and routes are not in it, because on iOS those
// belong to NEPacketTunnelNetworkSettings and must be applied before
// this is called.
//
// tunFd must stay open for the lifetime of the tunnel. It is duplicated
// here so that Stop closing it cannot pull the descriptor out from
// under the extension, which owns the original.
func WireGuardStart(uapiConfig string, tunFd int, mtu int) error {
	wgMu.Lock()
	defer wgMu.Unlock()
	if wgDevice != nil {
		return errors.New("neoxify: a WireGuard tunnel is already running")
	}

	name, err := utunName(tunFd)
	if err != nil {
		return err
	}

	duplicated, err := unix.Dup(tunFd)
	if err != nil {
		return fmt.Errorf("neoxify: could not duplicate the tunnel descriptor: %w", err)
	}
	// Non-blocking, because os.File's runtime poller expects it and a
	// blocking descriptor would park an OS thread on every read.
	if err := unix.SetNonblock(duplicated, true); err != nil {
		unix.Close(duplicated)
		return fmt.Errorf("neoxify: could not set the tunnel non-blocking: %w", err)
	}

	file := os.NewFile(uintptr(duplicated), name)
	t := &iosTUN{
		file:   file,
		io:     file,
		name:   name,
		mtu:    mtu,
		events: make(chan tun.Event, 4),
	}

	// LogLevelError, not Verbose. Verbose logs every handshake with the
	// peer's endpoint in it, and a node address in an extension's log is
	// exactly the kind of record this project keeps out of everything
	// else.
	d := device.NewDevice(t, conn.NewStdNetBind(), device.NewLogger(device.LogLevelError, "neoxify-wg: "))
	if err := d.IpcSet(uapiConfig); err != nil {
		d.Close()
		return fmt.Errorf("neoxify: the WireGuard configuration was rejected: %w", err)
	}
	if err := d.Up(); err != nil {
		d.Close()
		return fmt.Errorf("neoxify: the WireGuard tunnel would not start: %w", err)
	}

	// After Up, so a device that failed to start is not left recorded as
	// running -- Stop would then close a device the caller never had.
	t.events <- tun.EventUp
	wgDevice = d
	return nil
}

// WireGuardStop tears the tunnel down. Safe to call when nothing is
// running, for the reason Stop gives: the caller's disconnect path
// should not have to know.
func WireGuardStop() error {
	wgMu.Lock()
	defer wgMu.Unlock()
	if wgDevice == nil {
		return nil
	}
	wgDevice.Close()
	wgDevice = nil
	return nil
}

// WireGuardRunning reports whether a tunnel is up.
func WireGuardRunning() bool {
	wgMu.Lock()
	defer wgMu.Unlock()
	return wgDevice != nil
}
