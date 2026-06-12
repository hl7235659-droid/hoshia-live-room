package server

import "os"

type Config struct {
	Addr        string
	ServiceName string
	AuthToken   string
	Provider    string
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
		Addr:        addr,
		ServiceName: "hoshiaclaw",
		AuthToken:   token,
		Provider:    envOr("HOSHIACLAW_PROVIDER", "fake"),
	}
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
