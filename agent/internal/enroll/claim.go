package enroll

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"time"

	"github.com/neoxify/neoxify-hub/agent/internal/version"
)

type claimRequest struct {
	Token        string `json:"token"`
	PublicKey    string `json:"publicKey"`
	AgentVersion string `json:"agentVersion,omitempty"`
}

type claimResponse struct {
	NodeID string `json:"nodeId"`
}

// Claim trades a one-time admin-issued enrollment token for a Node ID,
// presenting the freshly generated public key so the control plane can
// verify this agent's signed Hello messages from now on. See
// docs/architecture.md for why this is a plain HTTPS call rather than
// part of the gRPC protocol: the agent has no other credential yet, and
// mixing "prove who I am for the first time" into the same channel used
// for ongoing authenticated traffic just complicates both.
func Claim(panelURL, token string, pub ed25519.PublicKey) (string, error) {
	body, err := json.Marshal(claimRequest{
		Token:        token,
		PublicKey:    base64.StdEncoding.EncodeToString(pub),
		AgentVersion: fmt.Sprintf("%s (%s/%s)", version.Version, runtime.GOOS, runtime.GOARCH),
	})
	if err != nil {
		return "", fmt.Errorf("encode claim request: %w", err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(panelURL+"/enrollment/claim", "application/json", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("call %s/enrollment/claim: %w", panelURL, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("enrollment claim rejected (%d): %s", resp.StatusCode, string(respBody))
	}

	var parsed claimResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("parse claim response: %w", err)
	}
	if parsed.NodeID == "" {
		return "", fmt.Errorf("claim response missing nodeId: %s", string(respBody))
	}
	return parsed.NodeID, nil
}
