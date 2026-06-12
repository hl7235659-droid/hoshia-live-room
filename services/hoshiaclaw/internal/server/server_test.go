package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(token string) *Server {
	return New(Config{
		Addr:        ":0",
		ServiceName: "hoshiaclaw",
		AuthToken:   token,
		Provider:    "fake",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestHealthzDoesNotRequireAuth(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "secret-token") {
		t.Fatalf("health response leaked token: %s", rec.Body.String())
	}
}

func TestProtectedEndpointRequiresBearerToken(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"text":"hi"}`))

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	assertJSONError(t, rec.Body.Bytes(), "token_missing")
}

func TestProtectedEndpointRejectsWrongBearerToken(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"text":"hi"}`))
	req.Header.Set("Authorization", "Bearer wrong")

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	assertJSONError(t, rec.Body.Bytes(), "unauthorized")
}

func TestBadJSONReturnsControlledError(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"text":`))
	req.Header.Set("Authorization", "Bearer secret-token")

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
	assertJSONError(t, rec.Body.Bytes(), "bad_json")
}

func TestGenerateStreamsNDJSON(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"text":"hello","nickname":"003","stream":true}`))
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Accept", "application/x-ndjson")

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/x-ndjson") {
		t.Fatalf("expected ndjson content type, got %q", got)
	}
	lines := strings.Split(strings.TrimSpace(rec.Body.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 ndjson lines, got %d: %q", len(lines), rec.Body.String())
	}
	if !strings.Contains(lines[0], `"type":"delta"`) || !strings.Contains(lines[1], `"type":"done"`) {
		t.Fatalf("unexpected stream body: %s", rec.Body.String())
	}
}

func TestGenerateStreamSkipped(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"stream":true}`))
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Accept", "application/x-ndjson")

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"type":"skipped"`) {
		t.Fatalf("expected skipped stream event, got %s", rec.Body.String())
	}
}

func TestSanitizerRedactsSensitiveValues(t *testing.T) {
	rec := httptest.NewRecorder()
	body := `{"text":"Bearer abc123 from https://example.invalid/a and C:\\Users\\me\\secret.txt","nickname":"003"}`
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", bytes.NewBufferString(body))
	req.Header.Set("Authorization", "Bearer secret-token")

	testServer("secret-token").Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	response := rec.Body.String()
	for _, forbidden := range []string{"abc123", "https://example.invalid", `C:\\Users\\me`} {
		if strings.Contains(response, forbidden) {
			t.Fatalf("response leaked %q: %s", forbidden, response)
		}
	}
}

func TestNewsEndpoints(t *testing.T) {
	app := testServer("secret-token").Handler()
	for _, path := range []string{
		"/live-room/capabilities/news/refresh",
		"/live-room/capabilities/news/status",
		"/live-room/capabilities/news/topics",
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"room_id":"room","limit":2}`))
		req.Header.Set("Authorization", "Bearer secret-token")
		app.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s expected 200, got %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func assertJSONError(t *testing.T, body []byte, expected string) {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("invalid json response: %v body=%s", err, body)
	}
	if payload["error"] != expected {
		t.Fatalf("expected error %q, got %#v", expected, payload["error"])
	}
}
