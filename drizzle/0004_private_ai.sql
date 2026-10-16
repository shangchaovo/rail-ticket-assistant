CREATE TABLE private_ai_limits (
  owner_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  busy_until INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT NOT NULL,
  PRIMARY KEY (owner_id,day)
);
