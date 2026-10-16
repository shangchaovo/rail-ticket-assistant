ALTER TABLE devices ADD COLUMN revoked_at TEXT;
ALTER TABLE devices ADD COLUMN runner_id TEXT;
ALTER TABLE devices ADD COLUMN runner_until TEXT;
ALTER TABLE devices ADD COLUMN resume_version INTEGER NOT NULL DEFAULT 0;
-- Keep only the most recently paired device when upgrading existing accounts.
UPDATE devices SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (
  SELECT id FROM (SELECT id,ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY created_at DESC,id DESC) AS position FROM devices) WHERE position>1
);
CREATE UNIQUE INDEX devices_one_active ON devices(owner_id) WHERE revoked_at IS NULL;
ALTER TABLE jobs ADD COLUMN watch_id TEXT;
CREATE UNIQUE INDEX jobs_one_watch_active ON jobs(watch_id) WHERE watch_id IS NOT NULL AND status IN ('queued','running','waiting_user');
CREATE TABLE watches (
  id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,input_json TEXT NOT NULL,
  start_at TEXT NOT NULL,interval_seconds INTEGER NOT NULL,end_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',
  stop_on_available INTEGER NOT NULL DEFAULT 1,next_run_at TEXT NOT NULL,last_run_at TEXT,last_job_id TEXT,
  was_available INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',site_origin TEXT NOT NULL,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE INDEX watches_due ON watches(status,next_run_at);
CREATE INDEX watches_owner ON watches(owner_id,created_at);
CREATE TABLE notification_settings (
  owner_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,bark_key TEXT,updated_at TEXT NOT NULL
);
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,
  title TEXT NOT NULL,message TEXT NOT NULL,url TEXT NOT NULL,created_at TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,claim_until TEXT,delivery_message TEXT NOT NULL DEFAULT '',delivered_at TEXT
);
CREATE INDEX notifications_due ON notification_events(delivery_status,next_attempt_at);
CREATE INDEX jobs_result_history ON jobs(owner_id,created_at DESC) WHERE result_json IS NOT NULL;
CREATE TABLE rail_maintenance (name TEXT PRIMARY KEY,last_ms INTEGER NOT NULL);
CREATE TABLE released_runners (device_id TEXT NOT NULL,runner_id TEXT NOT NULL,released_at TEXT NOT NULL,PRIMARY KEY(device_id,runner_id));
