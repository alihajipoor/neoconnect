BINARY := agentd
PKG := ./cmd/agentd

.PHONY: build build-linux-amd64 build-linux-arm64 test vet clean

build:
	go build -o bin/$(BINARY) $(PKG)

build-linux-amd64:
	GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o bin/$(BINARY)-linux-amd64 $(PKG)

build-linux-arm64:
	GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o bin/$(BINARY)-linux-arm64 $(PKG)

test:
	go test ./...

vet:
	go vet ./...

clean:
	rm -rf bin
