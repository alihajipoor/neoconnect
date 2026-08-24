BINARY := agentd
PKG := ./cmd/agentd
VERSION_PKG := github.com/neoxify/neoxify-hub/agent/internal/version

# The version the binary self-reports, and the same string the agent
# sends to the control plane as agentVersion (internal/controlplane's
# client.go and internal/enroll's claim.go both read version.Version).
#
# Until 2026-08-24 the release targets linked with `-s -w` and nothing
# else, so every published binary kept version.go's compile-time default
# and all six nodes reported agentVersion=dev. That made the panel
# useless for answering "which nodes took the rollout" -- the only way
# to tell one release from another was sha256 per node.
#
# Overridable so release-agent.yml can pass the tag it is building
# (VERSION=${{ github.ref_name }}) rather than depend on tags being
# present in a shallow checkout. The git describe fallback is for local
# builds; `dev` remains the last resort, but now only outside a git
# tree, never in a release.
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
VERSION_LDFLAGS := -X $(VERSION_PKG).Version=$(VERSION)

.PHONY: build build-linux-amd64 build-linux-arm64 test vet clean

build:
	go build -ldflags="$(VERSION_LDFLAGS)" -o bin/$(BINARY) $(PKG)

build-linux-amd64:
	GOOS=linux GOARCH=amd64 go build -ldflags="-s -w $(VERSION_LDFLAGS)" -o bin/$(BINARY)-linux-amd64 $(PKG)

build-linux-arm64:
	GOOS=linux GOARCH=arm64 go build -ldflags="-s -w $(VERSION_LDFLAGS)" -o bin/$(BINARY)-linux-arm64 $(PKG)

test:
	go test ./...

vet:
	go vet ./...

clean:
	rm -rf bin
