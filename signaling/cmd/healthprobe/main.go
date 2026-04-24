// Package main is a tiny static binary used as the container
// healthcheck for the signaling service.
//
// Why it exists: the production signaling image
// (signaling/Dockerfile) is based on gcr.io/distroless/static-*,
// which ships no shell, no wget, no curl, no nc. Docker's
// healthcheck test: ["CMD", ...] needs an executable it can invoke
// directly. This binary is that executable: it performs a single
// HTTP GET against /healthz on localhost and exits 0 on HTTP 200,
// non-zero on anything else.
//
// It is deliberately stdlib-only (net/http + os) so no new Go
// dependencies are introduced for Phase 13.
package main

import (
	"context"
	"net/http"
	"os"
	"time"
)

func main() {
	port := os.Getenv("SIGNALING_PORT")
	if port == "" {
		port = "8080"
	}
	url := "http://127.0.0.1:" + port + "/healthz"

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		os.Exit(2)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		os.Exit(1)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		os.Exit(1)
	}
}
