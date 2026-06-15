package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

func TestOpenAICompatibleGenerateJSONResponse(t *testing.T) {
	upstream := newMockChatCompletionServer(t, func(t *testing.T, r *http.Request, body map[string]any) string {
		t.Helper()
		if got := r.Header.Get("Authorization"); got != "Bearer test-openai-key" {
			t.Fatalf("unexpected authorization header %q", got)
		}
		if got := r.Header.Get("Accept"); got != "application/json" {
			t.Fatalf("unexpected accept header %q", got)
		}
		if got := r.Header.Get("User-Agent"); got != "HoshiaClaw/1.0" {
			t.Fatalf("unexpected user agent %q", got)
		}
		if body["model"] != "test-model" {
			t.Fatalf("unexpected model %#v", body["model"])
		}
		messages, _ := body["messages"].([]any)
		if len(messages) < 2 {
			t.Fatalf("expected chat messages, got %#v", body["messages"])
		}
		userMessage, _ := messages[1].(map[string]any)
		prompt := fmt.Sprint(userMessage["content"])
		for _, forbidden := range []string{"Bearer hidden-token", "https://internal.example", `C:\Users\me`} {
			if strings.Contains(prompt, forbidden) {
				t.Fatalf("prompt leaked %q: %s", forbidden, prompt)
			}
		}
		if !strings.Contains(prompt, "gateway_prompt:") || !strings.Contains(prompt, "active_context: 剧本杀朋友局") {
			t.Fatalf("gateway prompt was not forwarded: %s", prompt)
		}
		return `{"text":"收到，我会轻一点说。","state":"SPEAKING","skipped":false}`
	})
	defer upstream.Close()

	provider := newTestOpenAIProvider(upstream.URL)
	result, err := provider.Generate(context.Background(), generateRequest{
		Text:           "你好 Bearer hidden-token",
		Nickname:       "Alice",
		RoomID:         "room",
		ContextSummary: "summary https://internal.example/a",
		Prompt:         "active_context: 剧本杀朋友局 https://internal.example/prompt",
		Messages:       []chatMessage{{Nickname: "Bob", Text: `from C:\Users\me\secret.txt`}},
		CharacterSnapshotContext: map[string]any{
			"mood":         "calm",
			"provider_url": "https://internal.example/model",
		},
	})
	if err != nil {
		t.Fatalf("generate failed: %v", err)
	}
	if result.Source != openAICompatibleSource || result.Text != "收到，我会轻一点说。" || result.State != "SPEAKING" || result.Skipped {
		t.Fatalf("unexpected generate result: %#v", result)
	}
}

func TestOpenAICompatibleGeneratePlainTextFallback(t *testing.T) {
	upstream := newMockChatCompletionServer(t, func(t *testing.T, r *http.Request, _ map[string]any) string {
		t.Helper()
		return "我听见啦。"
	})
	defer upstream.Close()

	provider := newTestOpenAIProvider(upstream.URL)
	result, err := provider.Generate(context.Background(), generateRequest{Text: "hello"})
	if err != nil {
		t.Fatalf("generate failed: %v", err)
	}
	if result.Text != "我听见啦。" || result.State != "SPEAKING" || result.Skipped {
		t.Fatalf("unexpected fallback result: %#v", result)
	}
}

func TestOpenAICompatibleGenerateRejectsMalformedJSONText(t *testing.T) {
	upstream := newMockChatCompletionServer(t, func(t *testing.T, r *http.Request, _ map[string]any) string {
		t.Helper()
		return `{"text":"嘿嘿`
	})
	defer upstream.Close()

	provider := newTestOpenAIProvider(upstream.URL)
	_, err := provider.Generate(context.Background(), generateRequest{Text: "hello"})
	if err == nil || !strings.Contains(err.Error(), "provider_bad_json") {
		t.Fatalf("expected provider_bad_json, got %v", err)
	}
}

func TestOpenAICompatibleSummarizeJSONAndPlainText(t *testing.T) {
	responses := []string{
		`{"summary":"Alice 正在准备演示。 "}`,
		"Bob 刚进房间打招呼。",
	}
	upstream := newMockChatCompletionServer(t, func(t *testing.T, r *http.Request, _ map[string]any) string {
		t.Helper()
		if len(responses) == 0 {
			t.Fatal("unexpected extra upstream request")
		}
		next := responses[0]
		responses = responses[1:]
		return next
	})
	defer upstream.Close()

	provider := newTestOpenAIProvider(upstream.URL)
	first, err := provider.Summarize(context.Background(), summarizeRequest{Messages: []chatMessage{{Nickname: "Alice", Text: "我在准备演示"}}})
	if err != nil {
		t.Fatalf("summarize json failed: %v", err)
	}
	second, err := provider.Summarize(context.Background(), summarizeRequest{Messages: []chatMessage{{Nickname: "Bob", Text: "hi"}}})
	if err != nil {
		t.Fatalf("summarize text failed: %v", err)
	}
	if first.Summary != "Alice 正在准备演示。" || second.Summary != "Bob 刚进房间打招呼。" {
		t.Fatalf("unexpected summaries: %#v %#v", first, second)
	}
}

func TestOpenAICompatibleMusicIntentNormalization(t *testing.T) {
	responses := []string{
		`{"intent":"request","query":"Blue Bird","confidence":1.7}`,
		`{"intent":"delete_everything","query":"secret","confidence":0.8}`,
	}
	upstream := newMockChatCompletionServer(t, func(t *testing.T, r *http.Request, _ map[string]any) string {
		t.Helper()
		next := responses[0]
		responses = responses[1:]
		return next
	})
	defer upstream.Close()

	provider := newTestOpenAIProvider(upstream.URL)
	request, err := provider.MusicIntent(context.Background(), musicIntentRequest{Text: "点歌 Blue Bird"})
	if err != nil {
		t.Fatalf("music intent failed: %v", err)
	}
	invalid, err := provider.MusicIntent(context.Background(), musicIntentRequest{Text: "bad"})
	if err != nil {
		t.Fatalf("invalid music intent failed: %v", err)
	}
	if request.Intent != "request" || request.Query != "Blue Bird" || request.Confidence != 1 {
		t.Fatalf("unexpected request intent: %#v", request)
	}
	if invalid.Intent != "none" || invalid.Query != "" {
		t.Fatalf("unexpected invalid intent normalization: %#v", invalid)
	}
}

func TestOpenAICompatibleProviderFailureDoesNotLeakSecrets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `provider said key test-openai-key failed`, http.StatusUnauthorized)
	}))
	defer upstream.Close()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/live-room/generate", strings.NewReader(`{"text":"hi"}`))
	req.Header.Set("Authorization", "Bearer sidecar-token")
	New(Config{
		Addr:                      ":0",
		ServiceName:               "hoshiaclaw",
		AuthToken:                 "sidecar-token",
		Provider:                  "openai_compatible",
		OpenAICompatibleBaseURL:   upstream.URL + "/v1",
		OpenAICompatibleAPIKey:    "test-openai-key",
		OpenAICompatibleModel:     "test-model",
		OpenAICompatibleTimeout:   time.Second,
		OpenAICompatibleMaxTokens: 120,
		OpenAICompatibleTemp:      0.2,
	}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d body=%s", rec.Code, rec.Body.String())
	}
	response := rec.Body.String()
	for _, forbidden := range []string{"test-openai-key", upstream.URL, "provider said"} {
		if strings.Contains(response, forbidden) {
			t.Fatalf("response leaked %q: %s", forbidden, response)
		}
	}
	assertJSONError(t, rec.Body.Bytes(), "provider_failed")
}

func TestOpenAICompatibleProviderHTTP500AndTimeoutAreControlled(t *testing.T) {
	t.Run("http500", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "private upstream details", http.StatusInternalServerError)
		}))
		defer upstream.Close()

		_, err := newTestOpenAIProvider(upstream.URL).Generate(context.Background(), generateRequest{Text: "hi"})
		if err == nil || !strings.Contains(err.Error(), "provider_http_status_500") {
			t.Fatalf("expected safe http 500 error, got %v", err)
		}
		if strings.Contains(err.Error(), "private upstream details") || strings.Contains(err.Error(), "test-openai-key") {
			t.Fatalf("error leaked private details: %v", err)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			time.Sleep(200 * time.Millisecond)
			_, _ = w.Write([]byte(`{"choices":[]}`))
		}))
		defer upstream.Close()

		provider := newOpenAICompatibleProvider(Config{
			OpenAICompatibleBaseURL:   upstream.URL + "/v1",
			OpenAICompatibleAPIKey:    "test-openai-key",
			OpenAICompatibleModel:     "test-model",
			OpenAICompatibleTimeout:   25 * time.Millisecond,
			OpenAICompatibleMaxTokens: 120,
			OpenAICompatibleTemp:      0.2,
		})
		_, err := provider.Generate(context.Background(), generateRequest{Text: "hi"})
		if err == nil || !strings.Contains(err.Error(), "provider_timeout") {
			t.Fatalf("expected safe timeout error, got %v", err)
		}
		if strings.Contains(err.Error(), "test-openai-key") || strings.Contains(err.Error(), upstream.URL) {
			t.Fatalf("timeout error leaked private details: %v", err)
		}
	})
}

func TestOpenAICompatibleProviderLengthWithoutContentIsControlled(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{
					"finish_reason": "length",
					"message": map[string]any{
						"role":              "assistant",
						"content":           "",
						"reasoning_content": "long hidden reasoning",
					},
				},
			},
		})
	}))
	defer upstream.Close()

	_, err := newTestOpenAIProvider(upstream.URL).Generate(context.Background(), generateRequest{Text: "hi"})
	if err == nil || !strings.Contains(err.Error(), "provider_empty_content") {
		t.Fatalf("expected provider_empty_content, got %v", err)
	}
}

func newTestOpenAIProvider(upstreamURL string) Provider {
	return newOpenAICompatibleProvider(Config{
		OpenAICompatibleBaseURL:   upstreamURL + "/v1",
		OpenAICompatibleAPIKey:    "test-openai-key",
		OpenAICompatibleModel:     "test-model",
		OpenAICompatibleTimeout:   time.Second,
		OpenAICompatibleMaxTokens: 120,
		OpenAICompatibleTemp:      0.2,
	})
}

func newMockChatCompletionServer(t *testing.T, content func(*testing.T, *http.Request, map[string]any) string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("bad upstream request body: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]any{"role": "assistant", "content": content(t, r, body)}},
			},
		})
	}))
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
