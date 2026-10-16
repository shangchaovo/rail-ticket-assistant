-- Public geographic data only. No ticket queries or login data enter this cache.
CREATE TABLE IF NOT EXISTS rail_map_cache (
  cache_key TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rail_map_cache_expiry ON rail_map_cache (expires_at);
CREATE TABLE IF NOT EXISTS rail_map_locks (
  provider TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  until_ms INTEGER NOT NULL
);
