-- D1 bookkeeping for 100 MB chunked browser uploads.
CREATE TABLE IF NOT EXISTS upload_chunks (
  job_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  digest TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, part)
);
CREATE INDEX IF NOT EXISTS upload_chunks_status ON upload_chunks(job_id,state);
