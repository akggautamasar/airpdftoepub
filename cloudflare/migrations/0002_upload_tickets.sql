-- Short-lived capabilities for direct browser uploads; no permanent client key exposed.
CREATE TABLE IF NOT EXISTS upload_tickets (
 token_hash TEXT PRIMARY KEY,
 job_id TEXT NOT NULL UNIQUE,
 client_id TEXT NOT NULL,
 origin TEXT NOT NULL,
 file_bytes INTEGER NOT NULL,
 preset TEXT NOT NULL,
 languages TEXT NOT NULL,
 book_title TEXT,
 author TEXT,
 state TEXT NOT NULL DEFAULT 'ready',
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 FOREIGN KEY(client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS upload_tickets_pending ON upload_tickets(client_id,state,expires_at);
CREATE INDEX IF NOT EXISTS upload_tickets_expiry ON upload_tickets(expires_at);
