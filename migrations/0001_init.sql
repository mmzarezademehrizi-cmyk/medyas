CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  eitaa_token_enc TEXT NOT NULL DEFAULT '',
  eitaa_account TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'eitaa',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_id);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  silent INTEGER NOT NULL DEFAULT 0,
  pin INTEGER NOT NULL DEFAULT 0,
  view_delete INTEGER NOT NULL DEFAULT 0,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  eitaa_message_id TEXT NOT NULL DEFAULT '',
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_posts_due ON posts(status, run_at);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id, status);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
