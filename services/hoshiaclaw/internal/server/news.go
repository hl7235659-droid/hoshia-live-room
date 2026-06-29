package server

import (
	"sync"
	"time"
)

type newsStore struct {
	mu     sync.RWMutex
	status map[string]any
	topics []map[string]any
}

func newNewsStore() *newsStore {
	return &newsStore{
		status: map[string]any{
			"ok":              true,
			"state":           "idle",
			"last_refresh_at": "",
			"source":          "fake_provider",
		},
		topics: []map[string]any{},
	}
}

func (store *newsStore) Refresh(roomID string, limit int) map[string]any {
	store.mu.Lock()
	defer store.mu.Unlock()

	now := time.Now().UTC().Format(time.RFC3339)
	store.topics = defaultTopics(roomID, limit)
	store.status = map[string]any{
		"ok":              true,
		"state":           "ready",
		"last_refresh_at": now,
		"topic_count":     len(store.topics),
		"source":          "fake_provider",
	}
	return map[string]any{
		"ok":              true,
		"refreshed":       true,
		"last_refresh_at": now,
		"topic_count":     len(store.topics),
		"source":          "fake_provider",
	}
}

func (store *newsStore) Status() map[string]any {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return cloneMap(store.status)
}

func (store *newsStore) Topics(limit int) map[string]any {
	store.mu.RLock()
	defer store.mu.RUnlock()

	if limit <= 0 || limit > 20 {
		limit = 8
	}
	topics := make([]any, 0, min(limit, len(store.topics)))
	for i, topic := range store.topics {
		if i >= limit {
			break
		}
		topics = append(topics, cloneMap(topic))
	}
	return map[string]any{
		"ok":     true,
		"count":  len(topics),
		"topics": topics,
		"source": "fake_provider",
	}
}

func defaultTopics(roomID string, limit int) []map[string]any {
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	base := []map[string]any{
		{
			"date":                 time.Now().UTC().Format("2006-01-02"),
			"title":                "直播间备用新闻话题",
			"category":             "room",
			"what_happened":        "HoshiaClaw 当前使用 fake provider 生成安全话题卡。",
			"why_it_matters":       "真实新闻能力不可用时，直播间仍能返回稳定结构。",
			"hoshia_take":          "先聊轻松安全的话题，不装作看到了外部实时新闻。",
			"conversation_starter": "今天想听 Hoshia 从哪个角度聊近况？",
			"meme_hooks":           []any{"备用模式", "话题卡"},
			"reaction_style":       "轻松",
			"state_signal":         "fallback",
			"post_seed":            "备用新闻话题已就绪。",
			"reply_hooks":          []any{"可以继续问我想聊什么"},
			"risk_note":            "未连接真实新闻源，不声称实时性。",
			"tags":                 []any{"fallback", roomID},
		},
	}
	for len(base) < limit {
		base = append(base, cloneMap(base[0]))
	}
	return base[:limit]
}

func cloneMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
