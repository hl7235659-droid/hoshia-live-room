package server

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	cfg      Config
	logger   *slog.Logger
	provider Provider
	news     *newsStore
}

type generateRequest struct {
	Text                     string         `json:"text"`
	Prompt                   string         `json:"prompt"`
	Nickname                 string         `json:"nickname"`
	RoomID                   string         `json:"room_id"`
	Stream                   bool           `json:"stream"`
	ForceReply               bool           `json:"force_reply"`
	Messages                 []chatMessage  `json:"messages"`
	ContextSummary           string         `json:"context_summary"`
	CharacterSnapshotContext map[string]any `json:"character_snapshot_context"`
}

type summarizeRequest struct {
	ExistingSummary string        `json:"existing_summary"`
	PreviousSummary string        `json:"previous_summary"`
	Messages        []chatMessage `json:"messages"`
}

type chatMessage struct {
	Nickname string `json:"nickname"`
	Text     string `json:"text"`
}

type musicIntentRequest struct {
	Text string `json:"text"`
}

func New(cfg Config, logger *slog.Logger) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	return &Server{
		cfg:      cfg,
		logger:   logger,
		provider: newProvider(cfg),
		news:     newNewsStore(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealthz)
	mux.HandleFunc("POST /live-room/generate", s.withAuth(s.handleGenerate))
	mux.HandleFunc("POST /live-room/context/summarize", s.withAuth(s.handleSummarize))
	mux.HandleFunc("POST /live-room/music/intent", s.withAuth(s.handleMusicIntent))
	mux.HandleFunc("POST /live-room/capabilities/news/refresh", s.withAuth(s.handleNewsRefresh))
	mux.HandleFunc("POST /live-room/capabilities/news/status", s.withAuth(s.handleNewsStatus))
	mux.HandleFunc("POST /live-room/capabilities/news/topics", s.withAuth(s.handleNewsTopics))
	return mux
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"service": s.cfg.ServiceName,
		"source":  providerSource(s.cfg.Provider),
	})
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.AuthToken == "" {
			s.writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "token_missing"})
			return
		}
		auth := strings.TrimSpace(r.Header.Get("Authorization"))
		if auth == "" {
			s.writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "token_missing"})
			return
		}
		if auth != "Bearer "+s.cfg.AuthToken {
			s.writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

func (s *Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	var request generateRequest
	if !s.decodeJSON(w, r, &request) {
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	result, err := s.provider.Generate(ctx, request)
	if err != nil {
		s.logger.Warn("hoshiaclaw generate failed", "code", providerErrorCode(err))
		if shouldStream(request.Stream, r) {
			s.writeNDJSON(w, []map[string]any{{"type": "error", "ok": false, "error": "provider_failed"}})
			return
		}
		s.writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "provider_failed"})
		return
	}

	payload := map[string]any{
		"ok":      true,
		"text":    result.Text,
		"state":   result.State,
		"source":  result.Source,
		"skipped": result.Skipped,
	}
	if shouldStream(request.Stream, r) {
		if result.Skipped {
			s.writeNDJSON(w, []map[string]any{{"type": "skipped", "ok": true, "skipped": true, "source": result.Source}})
			return
		}
		s.writeNDJSON(w, []map[string]any{
			{"type": "delta", "text": result.Text, "source": result.Source},
			{"type": "done", "ok": true, "text": result.Text, "state": result.State, "source": result.Source},
		})
		return
	}
	s.writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleSummarize(w http.ResponseWriter, r *http.Request) {
	var request summarizeRequest
	if !s.decodeJSON(w, r, &request) {
		return
	}
	result, err := s.provider.Summarize(r.Context(), request)
	if err != nil {
		s.logger.Warn("hoshiaclaw summarize failed", "code", providerErrorCode(err))
		s.writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "provider_failed"})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"ok": true, "summary": result.Summary, "source": result.Source})
}

func (s *Server) handleMusicIntent(w http.ResponseWriter, r *http.Request) {
	var request musicIntentRequest
	if !s.decodeJSON(w, r, &request) {
		return
	}
	result, err := s.provider.MusicIntent(r.Context(), request)
	if err != nil {
		s.logger.Warn("hoshiaclaw music intent failed", "code", providerErrorCode(err))
		s.writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "provider_failed"})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{
		"ok": true,
		"intent": map[string]any{
			"intent":     result.Intent,
			"confidence": result.Confidence,
			"query":      result.Query,
			"queries":    []string{},
			"count":      1,
			"target":     map[string]any{"kind": ""},
			"reply_hint": "",
			"source":     result.Source,
		},
	})
}

func (s *Server) handleNewsRefresh(w http.ResponseWriter, r *http.Request) {
	var payload map[string]any
	if !s.decodeJSON(w, r, &payload) {
		return
	}
	roomID, _ := payload["room_id"].(string)
	if roomID == "" {
		roomID = "live-room"
	}
	limit := intFromAny(payload["limit"], 8)
	s.writeJSON(w, http.StatusOK, s.news.Refresh(clampText(roomID, 64), limit))
}

func (s *Server) handleNewsStatus(w http.ResponseWriter, r *http.Request) {
	if !s.decodeJSON(w, r, &map[string]any{}) {
		return
	}
	s.writeJSON(w, http.StatusOK, s.news.Status())
}

func (s *Server) handleNewsTopics(w http.ResponseWriter, r *http.Request) {
	var payload map[string]any
	if !s.decodeJSON(w, r, &payload) {
		return
	}
	limit := intFromAny(payload["limit"], 8)
	s.writeJSON(w, http.StatusOK, s.news.Topics(limit))
}

func (s *Server) decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad_json"})
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		s.writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad_json"})
		return false
	}
	return true
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(sanitizeMap(payload))
}

func (s *Server) writeNDJSON(w http.ResponseWriter, events []map[string]any) {
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	writer := bufio.NewWriter(w)
	for _, event := range events {
		line, err := json.Marshal(sanitizeMap(event))
		if err != nil {
			line, _ = json.Marshal(map[string]any{"type": "error", "ok": false, "error": "encode_failed"})
		}
		_, _ = writer.Write(append(line, '\n'))
	}
	_ = writer.Flush()
}

func shouldStream(stream bool, r *http.Request) bool {
	return stream && strings.Contains(r.Header.Get("Accept"), "application/x-ndjson")
}

func intFromAny(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func clampText(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
