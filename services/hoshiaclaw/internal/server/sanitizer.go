package server

import (
	"regexp"
	"strings"
)

var (
	bearerTokenPattern = regexp.MustCompile(`(?i)bearer\s+[a-z0-9._~+/=-]+`)
	urlPattern         = regexp.MustCompile(`(?i)\b(?:https?|wss?)://[^\s"'<>]+`)
	winPathPattern     = regexp.MustCompile(`(?i)\b[a-z]:\\[^\s"'<>]+`)
	unixPathPattern    = regexp.MustCompile(`(?:^|\s)/(?:home|root|etc|var|opt|srv|tmp|mnt|app|workspace|users?)(?:/[^\s"'<>]+)+`)
)

func sanitizeValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return sanitizeMap(typed)
	case []any:
		out := make([]any, 0, len(typed))
		for _, item := range typed {
			out = append(out, sanitizeValue(item))
		}
		return out
	case string:
		return sanitizeString(typed)
	default:
		return value
	}
}

func sanitizeMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		if sensitiveKey(key) {
			out[key] = "[redacted]"
			continue
		}
		out[key] = sanitizeValue(value)
	}
	return out
}

func sanitizeString(input string) string {
	text := bearerTokenPattern.ReplaceAllString(input, "Bearer [redacted]")
	text = urlPattern.ReplaceAllString(text, "[redacted-url]")
	text = winPathPattern.ReplaceAllString(text, "[redacted-path]")
	text = unixPathPattern.ReplaceAllStringFunc(text, func(match string) string {
		if strings.HasPrefix(match, " ") {
			return " [redacted-path]"
		}
		return "[redacted-path]"
	})
	return text
}

func sensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(key, "-", "_"), " ", "_"))
	sensitiveParts := []string{
		"token",
		"secret",
		"api_key",
		"apikey",
		"authorization",
		"provider_url",
		"url",
		"uri",
		"path",
		"file",
		"endpoint",
	}
	for _, part := range sensitiveParts {
		if normalized == part || strings.Contains(normalized, "_"+part) || strings.Contains(normalized, part+"_") {
			return true
		}
	}
	return false
}
