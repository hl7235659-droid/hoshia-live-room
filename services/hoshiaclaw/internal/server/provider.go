package server

import (
	"context"
	"fmt"
	"strings"
)

type Provider interface {
	Generate(ctx context.Context, request generateRequest) (generateResult, error)
	Summarize(ctx context.Context, request summarizeRequest) (summarizeResult, error)
	MusicIntent(ctx context.Context, request musicIntentRequest) (musicIntentResult, error)
}

type fakeProvider struct{}

type generateResult struct {
	Text    string
	State   string
	Source  string
	Skipped bool
}

type summarizeResult struct {
	Summary string
	Source  string
}

type musicIntentResult struct {
	Intent     string
	Query      string
	Confidence float64
	Source     string
}

func newProvider(cfg Config) Provider {
	switch strings.ToLower(strings.TrimSpace(cfg.Provider)) {
	case "openai_compatible", "openai-compatible", "openai":
		return newOpenAICompatibleProvider(cfg)
	default:
		return fakeProvider{}
	}
}

func providerSource(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "openai_compatible", "openai-compatible", "openai":
		return "openai_compatible"
	default:
		return "fake_provider"
	}
}

func normalizeCharacterState(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "IDLE", "LISTENING", "THINKING", "SPEAKING":
		return strings.ToUpper(strings.TrimSpace(value))
	default:
		return "SPEAKING"
	}
}

func normalizeMusicIntent(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "request", "request_many", "pause", "resume", "next", "previous", "remove", "status", "none":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "none"
	}
}

func clampConfidence(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func clampTextRunes(value string, limit int) string {
	value = strings.TrimSpace(value)
	if limit <= 0 {
		return ""
	}
	if len([]rune(value)) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func newFakeProvider() Provider {
	return fakeProvider{}
}

func (fakeProvider) Generate(_ context.Context, request generateRequest) (generateResult, error) {
	text := strings.TrimSpace(request.Text)
	if text == "" {
		return generateResult{
			Text:    "",
			State:   "IDLE",
			Source:  "fake_provider",
			Skipped: true,
		}, nil
	}
	name := strings.TrimSpace(request.Nickname)
	if name == "" {
		name = "viewer"
	}
	return generateResult{
		Text:   fmt.Sprintf("%s, I heard you. HoshiaClaw fallback reply: %s", name, text),
		State:  "SPEAKING",
		Source: "fake_provider",
	}, nil
}

func (fakeProvider) Summarize(_ context.Context, request summarizeRequest) (summarizeResult, error) {
	lines := make([]string, 0, len(request.Messages))
	for _, message := range request.Messages {
		text := strings.TrimSpace(message.Text)
		if text == "" {
			continue
		}
		name := strings.TrimSpace(message.Nickname)
		if name == "" {
			name = "viewer"
		}
		lines = append(lines, fmt.Sprintf("%s: %s", name, text))
		if len(lines) >= 5 {
			break
		}
	}
	previous := strings.TrimSpace(request.PreviousSummary)
	if previous == "" {
		previous = strings.TrimSpace(request.ExistingSummary)
	}
	if previous != "" {
		lines = append([]string{previous}, lines...)
	}
	if len(lines) == 0 {
		return summarizeResult{Summary: "No new live-room context to summarize.", Source: "fake_provider"}, nil
	}
	return summarizeResult{Summary: strings.Join(lines, " / "), Source: "fake_provider"}, nil
}

func (fakeProvider) MusicIntent(_ context.Context, request musicIntentRequest) (musicIntentResult, error) {
	text := strings.TrimSpace(request.Text)
	lower := strings.ToLower(text)
	result := musicIntentResult{Intent: "none", Confidence: 0.25, Source: "fake_provider"}
	if text == "" {
		return result, nil
	}
	if strings.Contains(lower, "pause") {
		result.Intent = "pause"
		result.Confidence = 0.8
		return result, nil
	}
	if strings.Contains(lower, "resume") || strings.Contains(lower, "continue") {
		result.Intent = "resume"
		result.Confidence = 0.8
		return result, nil
	}
	if strings.Contains(lower, "skip") || strings.Contains(lower, "next") {
		result.Intent = "next"
		result.Confidence = 0.8
		return result, nil
	}
	if strings.Contains(lower, "previous") || strings.Contains(lower, "last song") {
		result.Intent = "previous"
		result.Confidence = 0.75
		return result, nil
	}
	if strings.Contains(lower, "status") || strings.Contains(lower, "queue") {
		result.Intent = "status"
		result.Confidence = 0.7
		return result, nil
	}
	if strings.Contains(lower, "play") || strings.Contains(lower, "request") || strings.Contains(lower, "song") {
		result.Intent = "request"
		result.Query = clampText(text, 160)
		result.Confidence = 0.65
	}
	return result, nil
}
