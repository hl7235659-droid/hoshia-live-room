package server

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr                      string
	ServiceName               string
	AuthToken                 string
	Provider                  string
	OpenAICompatibleBaseURL   string
	OpenAICompatibleAPIKey    string
	OpenAICompatibleModel     string
	OpenAICompatibleTimeout   time.Duration
	OpenAICompatibleMaxTokens int
	OpenAICompatibleTemp      float64
}

func ConfigFromEnv() Config {
	addr := envOr("HOSHIACLAW_LISTEN_ADDR", envOr("HOSHIACLAW_ADDR", ":8080"))
	token := os.Getenv("HOSHIACLAW_TOKEN")
	if token == "" {
		token = os.Getenv("HOSHIACLAW_SHARED_TOKEN")
	}
	if token == "" {
		token = os.Getenv("ASTRBOT_BRIDGE_TOKEN")
	}
	return Config{
		Addr:                      addr,
		ServiceName:               "hoshiaclaw",
		AuthToken:                 token,
		Provider:                  envOr("HOSHIACLAW_PROVIDER", "fake"),
		OpenAICompatibleBaseURL:   envOr("HOSHIACLAW_OPENAI_BASE_URL", "https://api.openai.com/v1"),
		OpenAICompatibleAPIKey:    os.Getenv("HOSHIACLAW_OPENAI_API_KEY"),
		OpenAICompatibleModel:     os.Getenv("HOSHIACLAW_OPENAI_MODEL"),
		OpenAICompatibleTimeout:   durationFromEnv("HOSHIACLAW_OPENAI_TIMEOUT_MS", 30*time.Second),
		OpenAICompatibleMaxTokens: intFromEnv("HOSHIACLAW_OPENAI_MAX_TOKENS", 360),
		OpenAICompatibleTemp:      floatFromEnv("HOSHIACLAW_OPENAI_TEMPERATURE", 0.7),
	}
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func intFromEnv(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func floatFromEnv(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	if parsed < 0 {
		return 0
	}
	if parsed > 2 {
		return 2
	}
	return parsed
}

func durationFromEnv(key string, fallback time.Duration) time.Duration {
	value := intFromEnv(key, int(fallback/time.Millisecond))
	return time.Duration(value) * time.Millisecond
}
