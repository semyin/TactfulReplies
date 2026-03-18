package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestApp(t *testing.T) *app {
	t.Helper()

	root, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("abs root: %v", err)
	}

	return &app{
		root:    root,
		model:   defaultModel,
		baseURL: defaultBaseURL,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func TestHandleConfig(t *testing.T) {
	t.Setenv("DEEPSEEK_API_KEY", "test-key")

	server := httptest.NewServer(newMux(newTestApp(t)))
	defer server.Close()

	resp, err := http.Get(server.URL + "/api/config")
	if err != nil {
		t.Fatalf("get /api/config: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}

	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		t.Fatalf("decode json: %v", err)
	}

	if configured, ok := payload["configured"].(bool); !ok || !configured {
		t.Fatalf("configured = %v, want %v", payload["configured"], true)
	}

	if _, ok := payload["model"]; ok {
		t.Fatalf("config should not expose model")
	}

	if _, ok := payload["base_url"]; ok {
		t.Fatalf("config should not expose base_url")
	}
}

func TestServeIndexHTML(t *testing.T) {
	server := httptest.NewServer(newMux(newTestApp(t)))
	defer server.Close()

	resp, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatalf("get /: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}

	if !strings.Contains(string(body), "高明表达训练场") {
		t.Fatalf("index.html does not contain app title")
	}
}

func TestStaticDoesNotServeSensitiveFiles(t *testing.T) {
	server := httptest.NewServer(newMux(newTestApp(t)))
	defer server.Close()

	resp, err := http.Get(server.URL + "/main.go")
	if err != nil {
		t.Fatalf("get /main.go: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNotFound)
	}

	resp, err = http.Get(server.URL + "/.env.example")
	if err != nil {
		t.Fatalf("get /.env.example: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusNotFound)
	}
}

func TestLoadDotEnv(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, ".env")
	content := strings.Join([]string{
		"DEEPSEEK_API_KEY=from-dotenv",
		`DEEPSEEK_MODEL="deepseek-reasoner" # keep this comment`,
		`DEEPSEEK_BASE_URL=https://api.deepseek.com # inline comment`,
		"",
	}, "\n")

	if err := os.WriteFile(envPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	t.Setenv("DEEPSEEK_API_KEY", "")
	t.Setenv("DEEPSEEK_MODEL", "")
	t.Setenv("DEEPSEEK_BASE_URL", "")

	if err := loadDotEnv(envPath); err != nil {
		t.Fatalf("loadDotEnv: %v", err)
	}

	if got := os.Getenv("DEEPSEEK_API_KEY"); got != "from-dotenv" {
		t.Fatalf("DEEPSEEK_API_KEY = %q, want %q", got, "from-dotenv")
	}

	if got := os.Getenv("DEEPSEEK_MODEL"); got != "deepseek-reasoner" {
		t.Fatalf("DEEPSEEK_MODEL = %q, want %q", got, "deepseek-reasoner")
	}

	if got := os.Getenv("DEEPSEEK_BASE_URL"); got != "https://api.deepseek.com" {
		t.Fatalf("DEEPSEEK_BASE_URL = %q, want %q", got, "https://api.deepseek.com")
	}
}

func TestLoadDotEnvDoesNotOverrideExistingEnv(t *testing.T) {
	tempDir := t.TempDir()
	envPath := filepath.Join(tempDir, ".env")

	if err := os.WriteFile(envPath, []byte("DEEPSEEK_MODEL=from-dotenv\n"), 0o644); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	t.Setenv("DEEPSEEK_MODEL", "from-env")

	if err := loadDotEnv(envPath); err != nil {
		t.Fatalf("loadDotEnv: %v", err)
	}

	if got := os.Getenv("DEEPSEEK_MODEL"); got != "from-env" {
		t.Fatalf("DEEPSEEK_MODEL = %q, want %q", got, "from-env")
	}
}
