package neoxifyxray

// The engine end to end, on a Mac: the app's own configs (testdata/
// app-configs.json, written by the real builder in xray-config.ts), this
// package's Start, and a local Xray server built from the version the
// nodes run, with throwaway keys made per run.
//
// No utun is needed, and no root. The darwin TUN inbound takes a
// descriptor from xray.tun.fd and reads utun framing from it (a 4-byte
// family header, then the IP packet) -- so a datagram socketpair stands in
// for the device, and this side runs its own userspace TCP/IP stack on the
// other end, playing the apps on the phone. The engine runs in a child
// process (this test binary again), so its memory is its own and a panic
// in it ends only the child.
//
//   client stack (this process) --utun frames over a socketpair--> engine
//   child: TUN inbound -> app config's outbound --> xray server process
//   (127.0.0.1, inbounds shaped like the nodes') -> freedom, redirected to
//   a test service in this process (echo / download / upload sink / UDP
//   echo).
//
// What this is not: an iPhone. The footprint is a Mac process's, the
// network is loopback, and nothing here is the system's packet tunnel.
//
// Heavy, so opt-in:
//
//   NEOXIFY_ENGINE_E2E=1 go test -run 'TestEngineTransports|TestEngineSurvivesResetStorm' -v
//   NEOXIFY_ENGINE_MEMORY=1 go test -run TestEngineMemory -v -timeout 30m
//
// and with the iOS build's buffer cap, through the same script the
// xcframework build uses:
//
//   ../../../scripts/xray-core-patch.sh go test -run TestEngineMemory ...
//
// NEOXIFY_SERVER_CORE picks the server's xray-core (default v1.260327.0,
// 26.3.27, what the nodes run).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
	"gvisor.dev/gvisor/pkg/buffer"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
	"gvisor.dev/gvisor/pkg/tcpip/header"
	"gvisor.dev/gvisor/pkg/tcpip/link/channel"
	"gvisor.dev/gvisor/pkg/tcpip/network/ipv4"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
	"gvisor.dev/gvisor/pkg/tcpip/transport/udp"
	"gvisor.dev/gvisor/pkg/waiter"
)

const (
	e2eServerName = "neoxify.test"
	e2eMTU        = 1400
)

// Any address: the server's freedom outbound redirects everything to the
// test service. Outside 198.18.0.0/15's tunnel address, inside nothing real.
var e2eTarget = tcpip.AddrFrom4([4]byte{198, 19, 0, 10})

// ---------------------------------------------------------------- child

// TestEngineChild is the engine process. It does nothing unless started by
// startEngine.
func TestEngineChild(t *testing.T) {
	if os.Getenv("NEOXIFY_ENGINE_CHILD") != "1" {
		t.Skip("run by the end-to-end tests")
	}
	config, err := os.ReadFile(os.Getenv("NEOXIFY_ENGINE_CONFIG"))
	if err != nil {
		fmt.Println("CHILDERR", err)
		os.Exit(3)
	}
	BeginRun(os.Getenv("NEOXIFY_ENGINE_DIAG"))
	if err := Start(string(config), 3, noProtector{}); err != nil {
		fmt.Println("CHILDERR", err)
		os.Exit(3)
	}
	started := time.Now()
	fmt.Println("READY")
	for range time.Tick(250 * time.Millisecond) {
		hb := sampleHeartbeat(started)
		fmt.Printf("SAMPLE %d %d %d %d %d\n", time.Now().UnixMilli(), hb.Footprint, hb.FootprintPeak, hb.Heap, hb.Goroutines)
	}
}

type noProtector struct{}

func (noProtector) Protect(int) bool { return true }

// ---------------------------------------------------------------- server

type e2eKeys struct {
	uuid, trojanPassword          string
	realityPrivate, realityPublic string
	shortID                       string
	ssServerKey, ssUserKey        string
	certFile, keyFile, certPEM    string
	ports                         map[string]int
	servicePort, destPort         int
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func randB64(n int, enc *base64.Encoding) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return enc.EncodeToString(b)
}

func newKeys(t *testing.T) *e2eKeys {
	t.Helper()
	dir := t.TempDir()
	k := &e2eKeys{ports: map[string]int{}}
	u := make([]byte, 16)
	_, _ = rand.Read(u)
	u[6] = u[6]&0x0f | 0x40
	u[8] = u[8]&0x3f | 0x80
	k.uuid = fmt.Sprintf("%x-%x-%x-%x-%x", u[0:4], u[4:6], u[6:8], u[8:10], u[10:])
	k.trojanPassword = randB64(18, base64.RawURLEncoding)
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	k.realityPrivate = base64.RawURLEncoding.EncodeToString(priv.Bytes())
	k.realityPublic = base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes())
	sid := make([]byte, 8)
	_, _ = rand.Read(sid)
	k.shortID = hex.EncodeToString(sid)
	k.ssServerKey = randB64(32, base64.StdEncoding)
	k.ssUserKey = randB64(32, base64.StdEncoding)

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: e2eServerName},
		DNSNames:              []string{e2eServerName},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	k.certPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	kder, _ := x509.MarshalECPrivateKey(key)
	k.certFile = filepath.Join(dir, "cert.pem")
	k.keyFile = filepath.Join(dir, "key.pem")
	_ = os.WriteFile(k.certFile, []byte(k.certPEM), 0o600)
	_ = os.WriteFile(k.keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
	for _, name := range []string{"reality", "vless-tls-tcp", "vless-tls-ws", "trojan", "shadowsocks"} {
		k.ports[name] = freePort(t)
	}
	return k
}

// serverBinary builds xray-core's own main at the given version, once per
// machine (cached in the temp folder), from the module proxy -- the same
// source the nodes' binaries are released from.
func serverBinary(t *testing.T) string {
	t.Helper()
	version := os.Getenv("NEOXIFY_SERVER_CORE")
	if version == "" {
		version = "v1.260327.0"
	}
	dir := filepath.Join(os.TempDir(), "nx-xray-server-"+version)
	bin := filepath.Join(dir, "xray")
	if _, err := os.Stat(bin); err == nil {
		return bin
	}
	_ = os.MkdirAll(dir, 0o755)
	gomod := "module nxserver\n\ngo 1.26\n\nrequire github.com/xtls/xray-core " + version + "\n"
	if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte(gomod), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "build", "-mod=mod", "-o", bin, "github.com/xtls/xray-core/main")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOWORK=off", "GOFLAGS=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("building the %s server: %v\n%s", version, err, out)
	}
	return bin
}

// Inbounds shaped like installer/assets/xray-config.json.template,
// including how WebSocket is served: as a fallback path on the VLESS TLS
// (and Trojan) port, handed with PROXY protocol to a plain WebSocket
// inbound on loopback. The client dials the TLS port, as on a node.
func serverConfig(k *e2eKeys) string {
	tlsSettings := map[string]any{
		"alpn":         []string{"h2", "http/1.1"},
		"certificates": []map[string]any{{"certificateFile": k.certFile, "keyFile": k.keyFile}},
	}
	vlessClients := func(flow string) map[string]any {
		return map[string]any{"clients": []map[string]any{{"id": k.uuid, "flow": flow, "email": "c"}}, "decryption": "none"}
	}
	fallbacks := []map[string]any{
		{"path": "/ws", "dest": k.ports["vless-tls-ws"], "xver": 1},
		{"dest": k.destPort, "xver": 0},
	}
	loglevel := "warning"
	if v := os.Getenv("NEOXIFY_SERVER_LOG"); v != "" {
		loglevel = v
	}
	cfg := map[string]any{
		"log": map[string]any{"loglevel": loglevel},
		"inbounds": []map[string]any{
			{"listen": "127.0.0.1", "port": k.ports["reality"], "protocol": "vless", "settings": vlessClients("xtls-rprx-vision"),
				"streamSettings": map[string]any{"network": "tcp", "security": "reality", "realitySettings": map[string]any{
					"dest": fmt.Sprintf("127.0.0.1:%d", k.destPort), "serverNames": []string{e2eServerName},
					"privateKey": k.realityPrivate, "shortIds": []string{k.shortID}}}},
			{"listen": "127.0.0.1", "port": k.ports["vless-tls-tcp"], "protocol": "vless", "settings": withFallbacks(vlessClients("xtls-rprx-vision"), fallbacks),
				"streamSettings": map[string]any{"network": "tcp", "security": "tls", "tlsSettings": tlsSettings}},
			{"listen": "127.0.0.1", "port": k.ports["vless-tls-ws"], "protocol": "vless", "settings": vlessClients(""),
				"streamSettings": map[string]any{"network": "ws", "security": "none",
					"wsSettings": map[string]any{"path": "/ws"}, "sockopt": map[string]any{"acceptProxyProtocol": true}}},
			{"listen": "127.0.0.1", "port": k.ports["trojan"], "protocol": "trojan",
				"settings":       map[string]any{"clients": []map[string]any{{"password": k.trojanPassword, "email": "c"}}, "fallbacks": fallbacks},
				"streamSettings": map[string]any{"network": "tcp", "security": "tls", "tlsSettings": tlsSettings}},
			{"listen": "127.0.0.1", "port": k.ports["shadowsocks"], "protocol": "shadowsocks",
				"settings": map[string]any{"method": "2022-blake3-aes-256-gcm", "password": k.ssServerKey,
					"clients": []map[string]any{{"password": k.ssUserKey, "email": "c"}}, "network": "tcp,udp"}},
		},
		"outbounds": []map[string]any{
			{"protocol": "freedom", "settings": map[string]any{"redirect": fmt.Sprintf("127.0.0.1:%d", k.servicePort)}},
		},
	}
	data, _ := json.Marshal(cfg)
	return string(data)
}

func withFallbacks(settings map[string]any, fallbacks []map[string]any) map[string]any {
	settings["fallbacks"] = fallbacks
	return settings
}

// ---------------------------------------------------------------- service

// The far end of every connection: 'E' echoes; 'D' + uint64 n sends n
// bytes; 'U' + uint32 rate + uint64 n reads and discards n bytes at rate
// bytes a second (0 = as fast as it can), then answers with the count --
// not at EOF: a proxy closes both halves when one side shuts its own. UDP
// on the same port echoes.
func startService(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	pc, err := net.ListenPacket("udp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close(); pc.Close() })
	go func() {
		buf := make([]byte, 65536)
		for {
			n, addr, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			_, _ = pc.WriteTo(buf[:n], addr)
		}
	}()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go serveConn(c)
		}
	}()
	return port
}

var zeros = make([]byte, 64<<10)

func serveConn(c net.Conn) {
	defer c.Close()
	var cmd [1]byte
	if _, err := io.ReadFull(c, cmd[:]); err != nil {
		return
	}
	switch cmd[0] {
	case 'E':
		_, _ = io.Copy(c, c)
	case 'D':
		var n uint64
		if binary.Read(c, binary.BigEndian, &n) != nil {
			return
		}
		for n > 0 {
			chunk := uint64(len(zeros))
			if n < chunk {
				chunk = n
			}
			if _, err := c.Write(zeros[:chunk]); err != nil {
				return
			}
			n -= chunk
		}
	case 'U':
		var rate uint32
		var want uint64
		if binary.Read(c, binary.BigEndian, &rate) != nil || binary.Read(c, binary.BigEndian, &want) != nil {
			return
		}
		// An ack before the body, so the body is not part of the
		// client's first write; see firstWrite.
		if _, err := c.Write([]byte{'K'}); err != nil {
			return
		}
		var total uint64
		buf := make([]byte, 32<<10)
		start := time.Now()
		for total < want {
			chunk := buf
			if left := want - total; left < uint64(len(chunk)) {
				chunk = chunk[:left]
			}
			n, err := c.Read(chunk)
			total += uint64(n)
			if err != nil {
				return
			}
			if rate > 0 {
				due := start.Add(time.Duration(float64(total) / float64(rate) * float64(time.Second)))
				time.Sleep(time.Until(due))
			}
		}
		_ = binary.Write(c, binary.BigEndian, total)
	}
}

// REALITY borrows a real TLS 1.3 site's handshake; this is that site.
func startDest(t *testing.T, k *e2eKeys) int {
	t.Helper()
	cert, err := tls.LoadX509KeyPair(k.certFile, k.keyFile)
	if err != nil {
		t.Fatal(err)
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}, NextProtos: []string{"h2", "http/1.1"}, MinVersion: tls.VersionTLS13})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

type e2eEnv struct {
	keys *e2eKeys
	out  *lockedBuffer
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func startServerEnv(t *testing.T) *e2eEnv {
	t.Helper()
	bin := serverBinary(t)
	k := newKeys(t)
	k.servicePort = startService(t)
	k.destPort = startDest(t, k)
	cfgPath := filepath.Join(t.TempDir(), "server.json")
	_ = os.WriteFile(cfgPath, []byte(serverConfig(k)), 0o600)
	cmd := exec.Command(bin, "run", "-c", cfgPath)
	out := &lockedBuffer{}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	deadline := time.Now().Add(15 * time.Second)
	for _, p := range k.ports {
		for {
			c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", p))
			if err == nil {
				c.Close()
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("server did not listen:\n%s", out.String())
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	return &e2eEnv{keys: k, out: out}
}

// ---------------------------------------------------------------- client config

// appConfig is the app's config for one transport with the local server's
// address and throwaway credentials put in place of the fixture's
// placeholders. Only values change, never the shape -- with one
// test-only addition: the throwaway certificate is trusted through the
// outbound's own tlsSettings, since the Mac's trust store is the system's.
func appConfig(t *testing.T, k *e2eKeys, transport string) string {
	t.Helper()
	data, err := os.ReadFile("testdata/app-configs.json")
	if err != nil {
		t.Fatal(err)
	}
	var all map[string]map[string]any
	if err := json.Unmarshal(data, &all); err != nil {
		t.Fatal(err)
	}
	cfg := all[transport]
	if cfg == nil {
		t.Fatalf("no %s in the fixture", transport)
	}
	out := cfg["outbounds"].([]any)[0].(map[string]any)
	settings := out["settings"].(map[string]any)
	port := k.ports[transport]
	if transport == "vless-tls-ws" {
		// The node's TLS port; the WebSocket inbound behind it is internal.
		port = k.ports["vless-tls-tcp"]
	}
	if vnext, ok := settings["vnext"].([]any); ok {
		v := vnext[0].(map[string]any)
		v["address"], v["port"] = "127.0.0.1", port
		v["users"].([]any)[0].(map[string]any)["id"] = k.uuid
	}
	if servers, ok := settings["servers"].([]any); ok {
		s := servers[0].(map[string]any)
		s["address"], s["port"] = "127.0.0.1", port
		if out["protocol"] == "trojan" {
			s["password"] = k.trojanPassword
		} else {
			s["password"] = k.ssServerKey + ":" + k.ssUserKey
		}
	}
	if stream, ok := out["streamSettings"].(map[string]any); ok {
		if r, ok := stream["realitySettings"].(map[string]any); ok {
			r["publicKey"], r["shortId"] = k.realityPublic, k.shortID
		}
		if tl, ok := stream["tlsSettings"].(map[string]any); ok {
			tl["certificates"] = []map[string]any{{"usage": "verify", "certificate": strings.Split(strings.TrimSpace(k.certPEM), "\n")}}
		}
	}
	if v := os.Getenv("NEOXIFY_ENGINE_LOG"); v != "" {
		cfg["log"] = map[string]any{"loglevel": v}
	}
	b, _ := json.Marshal(cfg)
	return string(b)
}

// ---------------------------------------------------------------- engine + client stack

type sample struct {
	ms                    int64
	footprint, peak, heap int64
	goroutines            int64
}

type engine struct {
	t       *testing.T
	cmd     *exec.Cmd
	stack   *stack.Stack
	fd      int
	diag    string
	exited  chan struct{}
	exitErr error
	mu      sync.Mutex
	samples []sample
	output  bytes.Buffer
}

func startEngine(t *testing.T, config string) *engine {
	t.Helper()
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_DGRAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, fd := range fds {
		_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_SNDBUF, 2<<20)
		_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUF, 4<<20)
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "client.json")
	_ = os.WriteFile(cfgPath, []byte(config), 0o600)
	diag := filepath.Join(dir, "diag")

	child := os.NewFile(uintptr(fds[1]), "tun-child")
	cmd := exec.Command(os.Args[0], "-test.run=^TestEngineChild$", "-test.v=false", "-test.timeout=0")
	cmd.Env = append(os.Environ(), "NEOXIFY_ENGINE_CHILD=1", "NEOXIFY_ENGINE_CONFIG="+cfgPath, "NEOXIFY_ENGINE_DIAG="+diag)
	cmd.ExtraFiles = []*os.File{child}
	stdout, _ := cmd.StdoutPipe()
	e := &engine{t: t, cmd: cmd, fd: fds[0], diag: diag, exited: make(chan struct{})}
	cmd.Stderr = &lockedWriter{e: e}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	child.Close()
	ready := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		once := sync.Once{}
		for sc.Scan() {
			line := sc.Text()
			if line == "READY" {
				once.Do(func() { close(ready) })
				continue
			}
			var s sample
			if n, _ := fmt.Sscanf(line, "SAMPLE %d %d %d %d %d", &s.ms, &s.footprint, &s.peak, &s.heap, &s.goroutines); n == 5 {
				e.mu.Lock()
				e.samples = append(e.samples, s)
				e.mu.Unlock()
				continue
			}
			e.mu.Lock()
			e.output.WriteString(line + "\n")
			e.mu.Unlock()
		}
	}()
	go func() { e.exitErr = cmd.Wait(); close(e.exited) }()
	select {
	case <-ready:
	case <-e.exited:
		t.Fatalf("engine exited before it was ready: %v\n%s", e.exitErr, e.out())
	case <-time.After(20 * time.Second):
		t.Fatalf("engine not ready:\n%s", e.out())
	}
	e.stack = clientStack(t, fds[0])
	t.Cleanup(e.stop)
	return e
}

type lockedWriter struct{ e *engine }

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.e.mu.Lock()
	defer w.e.mu.Unlock()
	return w.e.output.Write(p)
}

func (e *engine) out() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.output.String()
}

func (e *engine) alive() bool {
	select {
	case <-e.exited:
		return false
	default:
		return true
	}
}

func (e *engine) stop() {
	if e.alive() {
		_ = e.cmd.Process.Kill()
		<-e.exited
	}
	_ = unix.Close(e.fd)
}

func (e *engine) samplesSince(ms int64) []sample {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []sample
	for _, s := range e.samples {
		if s.ms >= ms {
			out = append(out, s)
		}
	}
	return out
}

// clientStack plays the phone's apps: a userspace stack whose packets go
// to the engine as utun frames.
func clientStack(t *testing.T, fd int) *stack.Stack {
	s := stack.New(stack.Options{
		NetworkProtocols:   []stack.NetworkProtocolFactory{ipv4.NewProtocol},
		TransportProtocols: []stack.TransportProtocolFactory{tcp.NewProtocol, udp.NewProtocol},
	})
	ep := channel.New(4096, e2eMTU, "")
	if err := s.CreateNIC(1, ep); err != nil {
		t.Fatal(err)
	}
	addr := tcpip.ProtocolAddress{Protocol: ipv4.ProtocolNumber, AddressWithPrefix: tcpip.AddrFrom4([4]byte{198, 18, 0, 1}).WithPrefix()}
	if err := s.AddProtocolAddress(1, addr, stack.AddressProperties{}); err != nil {
		t.Fatal(err)
	}
	s.SetRouteTable([]tcpip.Route{{Destination: header.IPv4EmptySubnet, NIC: 1}})
	sack := tcpip.TCPSACKEnabled(true)
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &sack)
	// Like a phone's own stack: big enough not to be the bottleneck.
	rx := tcpip.TCPReceiveBufferSizeRangeOption{Min: 4 << 10, Default: 1 << 20, Max: 4 << 20}
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &rx)
	tx := tcpip.TCPSendBufferSizeRangeOption{Min: 4 << 10, Default: 1 << 20, Max: 4 << 20}
	s.SetTransportProtocolOption(tcp.ProtocolNumber, &tx)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); s.Close() })
	go func() {
		frame := make([]byte, 4+e2eMTU+64)
		for {
			pkt := ep.ReadContext(ctx)
			if pkt == nil {
				return
			}
			binary.BigEndian.PutUint32(frame, unix.AF_INET)
			n := 4
			for _, b := range pkt.AsSlices() {
				n += copy(frame[n:], b)
			}
			pkt.DecRef()
			for {
				_, err := unix.Write(fd, frame[:n])
				if err == unix.ENOBUFS || err == unix.EAGAIN {
					time.Sleep(100 * time.Microsecond)
					continue
				}
				break
			}
		}
	}()
	go func() {
		buf := make([]byte, 65536)
		for {
			n, err := unix.Read(fd, buf)
			if err != nil {
				if err == unix.EINTR {
					continue
				}
				return
			}
			if n <= 4 || buf[4]>>4 != 4 {
				continue
			}
			pkt := stack.NewPacketBuffer(stack.PacketBufferOptions{Payload: buffer.MakeWithData(append([]byte(nil), buf[4:n]...))})
			ep.InjectInbound(ipv4.ProtocolNumber, pkt)
			pkt.DecRef()
		}
	}()
	return s
}

func (e *engine) dial(port uint16) (*gonet.TCPConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return gonet.DialContextTCP(ctx, e.stack, tcpip.FullAddress{NIC: 1, Addr: e2eTarget, Port: port}, ipv4.ProtocolNumber)
}

// ---------------------------------------------------------------- transports

var e2eTransports = []string{"reality", "vless-tls-tcp", "vless-tls-ws", "trojan", "shadowsocks"}

func e2eEnabled(t *testing.T, env string) {
	if os.Getenv(env) != "1" {
		t.Skipf("set %s=1 to run (heavy: builds a server, starts engines)", env)
	}
}

// TestEngineTransports: every transport the phones offer carries bytes
// both ways through the app's own config -- TCP echo, a download, an
// upload, and UDP (DNS-sized) echoed back.
func TestEngineTransports(t *testing.T) {
	e2eEnabled(t, "NEOXIFY_ENGINE_E2E")
	env := startServerEnv(t)
	for _, transport := range e2eTransports {
		t.Run(transport, func(t *testing.T) {
			t.Cleanup(func() {
				if t.Failed() {
					t.Logf("server:\n%s", tail(env.out.String(), 20))
				}
			})
			e := startEngine(t, appConfig(t, env.keys, transport))

			payload := make([]byte, 1<<20)
			_, _ = rand.Read(payload)
			c, err := e.dial(80)
			if err != nil {
				t.Fatalf("dial: %v\n%s", err, e.out())
			}
			_ = c.SetDeadline(time.Now().Add(30 * time.Second))
			// The first 1 KiB on its own, then the rest: see firstWrite.
			if _, err := c.Write(append([]byte{'E'}, payload[:1024]...)); err != nil {
				t.Fatal(err)
			}
			got := make([]byte, len(payload))
			if _, err := io.ReadFull(c, got[:1024]); err != nil {
				t.Fatalf("TCP echo: %v\n%s", err, e.out())
			}
			go func() { _, _ = c.Write(payload[1024:]) }()
			if _, err := io.ReadFull(c, got[1024:]); err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("TCP echo of 1 MiB failed: %v\n%s", err, e.out())
			}
			c.Close()

			down := downloadFor(t, e, 32<<20)
			up := uploadFor(t, e, 32<<20, 0)

			uc, err := gonet.DialUDP(e.stack, nil, &tcpip.FullAddress{NIC: 1, Addr: e2eTarget, Port: 53}, ipv4.ProtocolNumber)
			if err != nil {
				t.Fatal(err)
			}
			defer uc.Close()
			echoed := 0
			for i := 0; i < 20; i++ {
				msg := make([]byte, 512)
				_, _ = rand.Read(msg)
				_ = uc.SetDeadline(time.Now().Add(3 * time.Second))
				if _, err := uc.Write(msg); err != nil {
					t.Fatal(err)
				}
				reply := make([]byte, 2048)
				n, err := uc.Read(reply)
				if err == nil && bytes.Equal(reply[:n], msg) {
					echoed++
				}
			}
			if echoed < 20 {
				t.Fatalf("UDP: %d of 20 datagrams came back\n%s", echoed, e.out())
			}
			if !e.alive() {
				t.Fatalf("engine died:\n%s", e.out())
			}
			t.Logf("RESULT %s: TCP echo 1 MiB ok; download 32 MiB %.0f Mbit/s; upload 32 MiB %.0f Mbit/s; UDP 20/20", transport, down, up)
		})
	}
}

// downloadFor fetches n bytes and returns Mbit/s.
func downloadFor(t *testing.T, e *engine, n uint64) float64 {
	t.Helper()
	c, err := e.dial(80)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(120 * time.Second))
	req := make([]byte, 9)
	req[0] = 'D'
	binary.BigEndian.PutUint64(req[1:], n)
	start := time.Now()
	if _, err := c.Write(req); err != nil {
		t.Fatal(err)
	}
	got, err := io.CopyN(io.Discard, c, int64(n))
	if err != nil {
		t.Fatalf("download: %d of %d bytes: %v\n%s", got, n, err, e.out())
	}
	return float64(n) * 8 / 1e6 / time.Since(start).Seconds()
}

// uploadFor sends n bytes to a sink reading at rate (0: unlimited) and
// returns Mbit/s, checked against the count the far end received.
func uploadFor(t *testing.T, e *engine, n uint64, rate uint32) float64 {
	t.Helper()
	c, err := e.dial(80)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(120 * time.Second))
	req := make([]byte, 13)
	req[0] = 'U'
	binary.BigEndian.PutUint32(req[1:], rate)
	binary.BigEndian.PutUint64(req[5:], n)
	start := time.Now()
	if err := firstWrite(c, req); err != nil {
		t.Fatalf("upload request: %v\n%s", err, e.out())
	}
	if _, err := io.CopyN(c, zeroReader{}, int64(n)); err != nil {
		t.Fatalf("upload: %v\n%s", err, e.out())
	}
	var got uint64
	if err := binary.Read(c, binary.BigEndian, &got); err != nil || got != n {
		t.Fatalf("upload: far end counted %d of %d: %v\n%s", got, n, err, e.out())
	}
	return float64(n) * 8 / 1e6 / time.Since(start).Seconds()
}

// firstWrite sends an upload's request and waits for the service's ack, so
// that the body does not arrive in the same read as the request.
//
// Xray's Trojan client sends the first data it reads (within 100 ms) in one
// 8 KiB buffer with its header, and fails the connection ("failed to write
// A request payload > buffer is full") when that first read is larger.
// Unchanged between 26.3.27 and 26.6.27 (proxy/trojan/client.go). A real
// app's first write after connecting is small -- a TLS ClientHello -- so
// these tests open the same way rather than as a bulk write.
func firstWrite(c net.Conn, req []byte) error {
	if _, err := c.Write(req); err != nil {
		return err
	}
	var ack [1]byte
	if _, err := io.ReadFull(c, ack[:]); err != nil {
		return err
	}
	if ack[0] != 'K' {
		return fmt.Errorf("bad ack %q", ack[0])
	}
	return nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// ---------------------------------------------------------------- the panic

// TestEngineSurvivesResetStorm is the trigger that killed xray-core
// 26.1.23 and 26.3.27 (journal, 2026-10-12): TCP connections reset right
// after their handshake, many a second. The TUN inbound read
// conn.RemoteAddr() of a gVisor connection that had already closed, got
// nil, and DestinationFromAddr panicked in a goroutine with "Net: Unknown
// address type" -- ending the process, which on a phone is the tunnel.
// Upstream's fix (#6365) is in v26.6.27. The engine must outlive the
// storm and leave no fatal output.
//
// Against the old pin (go.mod at v1.260327.0) this fails: see the
// journal entry of 2026-11-12 for the run.
func TestEngineSurvivesResetStorm(t *testing.T) {
	e2eEnabled(t, "NEOXIFY_ENGINE_E2E")
	env := startServerEnv(t)
	e := startEngine(t, appConfig(t, env.keys, "reality"))

	duration := 20 * time.Second
	if d, err := time.ParseDuration(os.Getenv("NEOXIFY_STORM")); err == nil {
		duration = d
	}
	var attempts, established atomic.Int64
	stop := time.Now().Add(duration)
	var wg sync.WaitGroup
	for w := 0; w < 32; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for time.Now().Before(stop) && e.alive() {
				attempts.Add(1)
				if connectThenReset(e.stack) {
					established.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	// Give a panic in flight time to land.
	time.Sleep(2 * time.Second)
	rate := float64(established.Load()) / duration.Seconds()
	t.Logf("RESULT reset storm: %d handshakes reset (%d attempts, %.0f a second) in %s; engine alive=%v",
		established.Load(), attempts.Load(), rate, duration, e.alive())
	if !e.alive() {
		t.Fatalf("the engine died under the reset storm: %v\n%s", e.exitErr, tail(e.out(), 30))
	}
	if data, _ := os.ReadFile(filepath.Join(e.diag, fatalFile)); len(data) > 0 {
		t.Fatalf("fatal output recorded:\n%s", data)
	}
	// And it still carries traffic afterwards.
	if mbps := downloadFor(t, e, 4<<20); mbps <= 0 {
		t.Fatal("no traffic after the storm")
	}
}

// connectThenReset completes a handshake and aborts at once: an RST
// straight after the ACK.
func connectThenReset(s *stack.Stack) bool {
	var wq waiter.Queue
	ep, err := s.NewEndpoint(tcp.ProtocolNumber, ipv4.ProtocolNumber, &wq)
	if err != nil {
		return false
	}
	entry, ch := waiter.NewChannelEntry(waiter.WritableEvents | waiter.EventHUp | waiter.EventErr)
	wq.EventRegister(&entry)
	defer wq.EventUnregister(&entry)
	if err := ep.Connect(tcpip.FullAddress{NIC: 1, Addr: e2eTarget, Port: 443}); err != nil {
		if _, started := err.(*tcpip.ErrConnectStarted); !started {
			ep.Abort()
			return false
		}
		select {
		case <-ch:
		case <-time.After(3 * time.Second):
			ep.Abort()
			return false
		}
	}
	ok := ep.LastError() == nil
	ep.Abort()
	return ok
}

func tail(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// ---------------------------------------------------------------- memory

// TestEngineMemory rebuilds the 2026-11-12 measurement as a repeatable
// test: a fresh engine per scenario, its footprint and Go heap sampled
// four times a second by the engine process itself. Scenarios: idle;
// one fast download and one fast upload (the speed figures); 4 and 8
// parallel uploads into a sink held at 256 KiB/s each (a stalled uplink:
// the far end takes data slower than the phone's apps offer it, which is
// what held ~8 MiB per upload in the engine's TCP stack); 8 parallel
// fast uploads; 8 downloads read slowly by the "apps"; and many short
// connections. Reports; asserts only that the engine lived.
func TestEngineMemory(t *testing.T) {
	e2eEnabled(t, "NEOXIFY_ENGINE_MEMORY")
	env := startServerEnv(t)
	transports := []string{"shadowsocks", "reality"}
	if v := os.Getenv("NEOXIFY_MEM_TRANSPORTS"); v != "" {
		transports = strings.Split(v, ",")
	}
	window := 20 * time.Second
	if d, err := time.ParseDuration(os.Getenv("NEOXIFY_MEM_WINDOW")); err == nil {
		window = d
	}
	type scenario struct {
		name string
		run  func(t *testing.T, e *engine) string
	}
	scenarios := []scenario{
		{"idle", func(t *testing.T, e *engine) string { time.Sleep(window / 2); return "" }},
		{"download1-fast", func(t *testing.T, e *engine) string {
			return fmt.Sprintf("%.0f Mbit/s", downloadFor(t, e, 512<<20))
		}},
		{"upload1-fast", func(t *testing.T, e *engine) string {
			return fmt.Sprintf("%.0f Mbit/s", uploadFor(t, e, 512<<20, 0))
		}},
		{"upload4-stalled", func(t *testing.T, e *engine) string { return parallelUploads(t, e, 4, 256<<10, window) }},
		{"upload8-stalled", func(t *testing.T, e *engine) string { return parallelUploads(t, e, 8, 256<<10, window) }},
		{"upload8-fast", func(t *testing.T, e *engine) string { return parallelUploads(t, e, 8, 0, window) }},
		{"download8-slowread", func(t *testing.T, e *engine) string { return slowDownloads(t, e, 8, 256<<10, window) }},
		// Browsing-like: 50 short connections a second, above the 10-30 a
		// second seen from the reporting customer's phone.
		{"shortconns-50s", func(t *testing.T, e *engine) string { return shortConns(t, e, 50, window) }},
		// As fast as 16 workers can open them: far past any app.
		{"shortconns-flood", func(t *testing.T, e *engine) string { return shortConns(t, e, 0, window) }},
	}
	if v := os.Getenv("NEOXIFY_MEM_SCENARIOS"); v != "" {
		keep := map[string]bool{}
		for _, s := range strings.Split(v, ",") {
			keep[s] = true
		}
		var picked []scenario
		for _, s := range scenarios {
			if keep[s.name] {
				picked = append(picked, s)
			}
		}
		scenarios = picked
	}
	for _, transport := range transports {
		for _, sc := range scenarios {
			t.Run(transport+"/"+sc.name, func(t *testing.T) {
				e := startEngine(t, appConfig(t, env.keys, transport))
				time.Sleep(time.Second)
				from := time.Now().UnixMilli()
				note := sc.run(t, e)
				time.Sleep(time.Second)
				ss := e.samplesSince(from)
				if !e.alive() {
					t.Fatalf("engine died: %v\n%s", e.exitErr, tail(e.out(), 30))
				}
				var fpPeak, heapPeak, gPeak, kernelPeak int64
				var fps []int64
				for _, s := range ss {
					fpPeak = max(fpPeak, s.footprint)
					heapPeak = max(heapPeak, s.heap)
					gPeak = max(gPeak, s.goroutines)
					kernelPeak = max(kernelPeak, s.peak)
					fps = append(fps, s.footprint)
				}
				sort.Slice(fps, func(i, j int) bool { return fps[i] < fps[j] })
				median := int64(0)
				if len(fps) > 0 {
					median = fps[len(fps)/2]
				}
				mib := func(v int64) float64 { return float64(v) / (1 << 20) }
				t.Logf("RESULT %-12s %-20s footprint peak %5.1f MiB (median %5.1f, kernel peak %5.1f)  heap peak %5.1f MiB  goroutines %4d  %s",
					transport, sc.name, mib(fpPeak), mib(median), mib(kernelPeak), mib(heapPeak), gPeak, note)
			})
		}
	}
}

func parallelUploads(t *testing.T, e *engine, n int, rate uint32, window time.Duration) string {
	var sent atomic.Int64
	var wg sync.WaitGroup
	deadline := time.Now().Add(window)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := e.dial(80)
			if err != nil {
				return
			}
			defer c.Close()
			req := make([]byte, 13)
			req[0] = 'U'
			binary.BigEndian.PutUint32(req[1:], rate)
			binary.BigEndian.PutUint64(req[5:], 1<<40)
			if firstWrite(c, req) != nil {
				return
			}
			buf := make([]byte, 64<<10)
			for time.Now().Before(deadline) {
				_ = c.SetWriteDeadline(deadline)
				k, err := c.Write(buf)
				sent.Add(int64(k))
				if err != nil {
					return
				}
			}
		}()
	}
	wg.Wait()
	return fmt.Sprintf("%.1f Mbit/s offered and taken by the engine", float64(sent.Load())*8/1e6/window.Seconds())
}

func slowDownloads(t *testing.T, e *engine, n int, rate int, window time.Duration) string {
	var got atomic.Int64
	var wg sync.WaitGroup
	deadline := time.Now().Add(window)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := e.dial(80)
			if err != nil {
				return
			}
			defer c.Close()
			req := make([]byte, 9)
			req[0] = 'D'
			binary.BigEndian.PutUint64(req[1:], 1<<40)
			_, _ = c.Write(req)
			buf := make([]byte, 16<<10)
			start := time.Now()
			var total int64
			for time.Now().Before(deadline) {
				_ = c.SetReadDeadline(deadline)
				k, err := c.Read(buf)
				total += int64(k)
				got.Add(int64(k))
				if err != nil {
					return
				}
				time.Sleep(time.Until(start.Add(time.Duration(float64(total) / float64(rate) * float64(time.Second)))))
			}
		}()
	}
	wg.Wait()
	return fmt.Sprintf("%.1f Mbit/s read", float64(got.Load())*8/1e6/window.Seconds())
}

// shortConns opens connections that each echo 1 KiB and close, rate a
// second (0: as fast as 16 workers go).
func shortConns(t *testing.T, e *engine, rate int, window time.Duration) string {
	var done, failed atomic.Int64
	var wg sync.WaitGroup
	deadline := time.Now().Add(window)
	var tokens chan struct{}
	if rate > 0 {
		tokens = make(chan struct{})
		go func() {
			tick := time.NewTicker(time.Second / time.Duration(rate))
			defer tick.Stop()
			for now := range tick.C {
				if now.After(deadline) {
					close(tokens)
					return
				}
				select {
				case tokens <- struct{}{}:
				default:
				}
			}
		}()
	}
	for w := 0; w < 16; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			msg := make([]byte, 1024)
			reply := make([]byte, 1024)
			for time.Now().Before(deadline) {
				if tokens != nil {
					if _, ok := <-tokens; !ok {
						return
					}
				}
				c, err := e.dial(80)
				if err != nil {
					failed.Add(1)
					continue
				}
				_ = c.SetDeadline(time.Now().Add(5 * time.Second))
				_, err1 := c.Write(append([]byte{'E'}, msg...))
				_, err2 := io.ReadFull(c, reply)
				c.Close()
				if err1 != nil || err2 != nil {
					failed.Add(1)
				} else {
					done.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	return fmt.Sprintf("%.0f connections a second (%d failed)", float64(done.Load())/window.Seconds(), failed.Load())
}
