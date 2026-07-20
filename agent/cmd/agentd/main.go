// Command agentd is the NeoConnect node agent: it runs on each VPS node,
// manages local VPN protocol engines, and syncs state with the control plane.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

func main() {
	enrollInit := flag.Bool("enroll-init", false, "generate a keypair and print an enrollment token, then exit")
	flag.Parse()

	if *enrollInit {
		if err := runEnrollInit(); err != nil {
			log.Fatalf("enroll-init failed: %v", err)
		}
		return
	}

	fmt.Fprintln(os.Stderr, "agentd: control-plane connect loop not yet implemented (see M2)")
	os.Exit(1)
}

func runEnrollInit() error {
	return fmt.Errorf("not yet implemented (see M2: agent skeleton + enrollment flow)")
}
