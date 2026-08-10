// Package neoxifyxray runs xray-core inside the Android app.
//
// Not a port and not a reimplementation: this is the same xray-core
// binary-equivalent that every Neoxify node runs, compiled into the APK
// as a library. That is the decision this project has made at every
// layer -- the agent manages real engines, the Windows client bundles
// real binaries -- and the reason is always the same: a protocol-level
// fix upstream becomes a version bump instead of a rewrite.
//
// Two things make this possible on Android without a second networking
// stack, and both were checked in xray-core's own source rather than
// assumed:
//
//   - xray-core has a first-party `tun` inbound that, on Android, reads
//     a file descriptor from the `xray.tun.fd` environment variable and
//     wraps it in a gVisor endpoint. So VpnService's descriptor can be
//     handed straight to it. No tun2socks, no local SOCKS hop.
//   - `internet.RegisterDialerController` hands every outbound socket to
//     a callback before it is used, which is where VpnService.protect
//     goes. Without that, xray's own connections to the server would be
//     routed back into the tunnel it is serving -- a loop that presents
//     as "connects, then nothing loads".
package neoxifyxray

import (
	"fmt"
	"os"
	"sync"
	"syscall"

	"github.com/xtls/xray-core/common/platform"
	core "github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/infra/conf/serial"
	"github.com/xtls/xray-core/transport/internet"

	// The engines this app offers. Imported for their side-effect
	// registration, exactly as xray-core's own main package does -- an
	// unimported protocol is simply absent at runtime, and the failure
	// looks like a config error rather than a missing build tag.
	_ "github.com/xtls/xray-core/app/dispatcher"
	_ "github.com/xtls/xray-core/app/proxyman/inbound"
	_ "github.com/xtls/xray-core/app/proxyman/outbound"
	_ "github.com/xtls/xray-core/proxy/freedom"
	// Shadowsocks 2022. The whole package, not a .../outbound
	// subpackage: unlike VLESS and VMess this one keeps client and
	// server together, and it is the 2022 package rather than
	// proxy/shadowsocks -- a 2022 cipher is routed to
	// shadowsocks_2022.ClientConfig by the config layer, so importing
	// the original package would register the wrong thing and leave this
	// one absent.
	_ "github.com/xtls/xray-core/proxy/shadowsocks_2022"
	_ "github.com/xtls/xray-core/proxy/trojan"
	_ "github.com/xtls/xray-core/proxy/tun"
	_ "github.com/xtls/xray-core/proxy/vless/outbound"
	_ "github.com/xtls/xray-core/proxy/vmess/outbound"
	_ "github.com/xtls/xray-core/transport/internet/grpc"
	_ "github.com/xtls/xray-core/transport/internet/reality"
	_ "github.com/xtls/xray-core/transport/internet/tcp"
	_ "github.com/xtls/xray-core/transport/internet/tls"
	_ "github.com/xtls/xray-core/transport/internet/websocket"
)

// Protector is implemented on the Kotlin side by the VpnService.
//
// gomobile turns this into a Java interface, so the Go code below can
// call back into the service that owns the tunnel. It exists for one
// job: keep xray's own sockets out of the tunnel.
type Protector interface {
	// Protect excludes a socket from the VPN. Returns false if Android
	// refused, which in practice means the service is already gone.
	Protect(fd int) bool
}

var (
	mu       sync.Mutex
	instance *core.Instance
	// Registered once for the life of the process: xray-core appends
	// controllers to a package-level dialer and offers no way to remove
	// one, so re-registering on every connect would stack up a new
	// closure per attempt, each holding a dead VpnService.
	controllerOnce sync.Once
	// Read by that controller, replaced on each connect. Guarded because
	// the dialer calls it from its own goroutines.
	protector   Protector
	protectorMu sync.RWMutex
)

// Start brings up xray-core against an already-established TUN device.
//
// tunFd must come from VpnService.Builder.establish() and must stay open
// for the lifetime of the instance -- xray reads from it directly, and
// closing it on the Kotlin side pulls the floor out from under the
// gVisor stack.
func Start(configJSON string, tunFd int, p Protector) error {
	mu.Lock()
	defer mu.Unlock()

	if instance != nil {
		return fmt.Errorf("xray is already running")
	}
	if tunFd <= 0 {
		return fmt.Errorf("invalid tun file descriptor %d", tunFd)
	}

	protectorMu.Lock()
	protector = p
	protectorMu.Unlock()

	var registerErr error
	controllerOnce.Do(func() {
		registerErr = internet.RegisterDialerController(func(network, address string, conn syscall.RawConn) error {
			protectorMu.RLock()
			current := protector
			protectorMu.RUnlock()
			if current == nil {
				return nil
			}
			// Control runs the callback with the socket's real fd. Any
			// error here is the socket's, not ours -- report it rather
			// than let an unprotected socket loop back into the tunnel.
			return conn.Control(func(fd uintptr) {
				current.Protect(int(fd))
			})
		})
	})
	if registerErr != nil {
		return fmt.Errorf("could not install the socket protector: %w", registerErr)
	}

	// How xray-core's Android tun inbound finds the descriptor. Set
	// before the config is loaded, because the inbound reads it while
	// being constructed.
	if err := os.Setenv(platform.TunFdKey, fmt.Sprint(tunFd)); err != nil {
		return fmt.Errorf("could not publish the tun descriptor: %w", err)
	}

	config, err := serial.LoadJSONConfig(newReader(configJSON))
	if err != nil {
		return fmt.Errorf("bad xray config: %w", err)
	}

	inst, err := core.New(config)
	if err != nil {
		return fmt.Errorf("could not build xray: %w", err)
	}
	if err := inst.Start(); err != nil {
		_ = inst.Close()
		return fmt.Errorf("could not start xray: %w", err)
	}

	instance = inst
	return nil
}

// Stop tears the instance down. Safe to call when nothing is running,
// because the caller's disconnect path should not have to know.
func Stop() error {
	mu.Lock()
	defer mu.Unlock()

	protectorMu.Lock()
	protector = nil
	protectorMu.Unlock()

	if instance == nil {
		return nil
	}
	err := instance.Close()
	instance = nil
	return err
}

// Running reports whether an instance is up.
//
// Deliberately the only status this exposes. Unlike WireGuard there is
// no handshake to read here, so anything more would be inventing
// evidence -- the app proves an Xray tunnel works by sending real
// traffic through it, which is the stronger test anyway.
func Running() bool {
	mu.Lock()
	defer mu.Unlock()
	return instance != nil
}
