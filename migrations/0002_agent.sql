-- Agent: free-form automatic jobs. The owner describes the task in plain Persian; an LLM-driven agent carries it out on schedule.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,            -- target channel (channels.id) the posts go to
  name TEXT NOT NULL DEFAULT '',
  instruction TEXT NOT NULL,              -- the owner's task, in his own words
  times TEXT NOT NULL DEFAULT '[]',       -- JSON array of "HH:MM" (Tehran)
  days TEXT,                              -- JSON array of weekdays (0=Sunday..6=Saturday) or NULL = every day
  once_at INTEGER,                        -- one-time task: epoch seconds
  footer TEXT NOT NULL DEFAULT '',        -- appended verbatim to every post (the owner's channel signature)
  approve INTEGER NOT NULL DEFAULT 0,     -- 1 = send a draft to the owner for approval first
  enabled INTEGER NOT NULL DEFAULT 1,
  run_now INTEGER NOT NULL DEFAULT 0,     -- manual "run now" request
  last_key TEXT NOT NULL DEFAULT '',      -- last handled slot "YYYY-MM-DD HH:MM"
  retry_at INTEGER,                       -- in-progress slot: next attempt (epoch); also the claim lock
  attempts INTEGER NOT NULL DEFAULT 0,
  last_info TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_user ON agent_jobs(user_id);
CREATE TABLE IF NOT EXISTS agent_seen (
  job_id INTEGER NOT NULL,
  k TEXT NOT NULL,                        -- "<source channel>/<message id>"
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, k)
);
ALTER TABLE posts ADD COLUMN src_url TEXT NOT NULL DEFAULT '';  -- image fetched from this URL instead of a Telegram file
ALTER TABLE posts ADD COLUMN job_id INTEGER;
