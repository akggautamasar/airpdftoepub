CREATE TABLE IF NOT EXISTS clients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
 max_jobs_per_day INTEGER NOT NULL DEFAULT 20,
 usage_day TEXT NOT NULL DEFAULT '', used_jobs INTEGER NOT NULL DEFAULT 0,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, idempotency_key TEXT,
 state TEXT NOT NULL DEFAULT 'queued', preset TEXT NOT NULL, languages TEXT NOT NULL,
 book_title TEXT, author TEXT,
 input_key TEXT NOT NULL, output_key TEXT, original_bytes INTEGER NOT NULL,
 output_bytes INTEGER, progress INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
 report_json TEXT, last_error TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(client_id) REFERENCES clients(id),
 UNIQUE(client_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_retry ON jobs(state,lease_until);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at,state);
CREATE INDEX IF NOT EXISTS jobs_client ON jobs(client_id,created_at);
