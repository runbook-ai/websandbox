-- websandbox mail: one mailbox per user; every message row belongs to one mailbox (owner_id).
-- Mail between two users on the site is two rows (the sender's Sent copy, the recipient's Inbox copy)
-- sharing message_id. Times are 'YYYY-MM-DD HH:MM:SS' UTC.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  persona_id TEXT,                       -- world persona (hidden; generators and graders only)
  username TEXT NOT NULL UNIQUE,         -- login = local part of the primary address
  display_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,            -- primary address
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  signature TEXT NOT NULL DEFAULT '',
  page_size INTEGER NOT NULL DEFAULT 50,
  vacation_on INTEGER NOT NULL DEFAULT 0,
  vacation_subject TEXT NOT NULL DEFAULT '',
  vacation_body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
-- Extra "send mail as" addresses (e.g. a work address next to the personal one).
CREATE TABLE user_addresses (
  user_id INTEGER NOT NULL REFERENCES users(id),
  email TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, email)
) WITHOUT ROWID;

-- Every address that appears in mail. kind: user (has a mailbox here) | person | list | vendor | system.
-- delivery: what happens to mail sent to it: ok | bounce (no such user) | autoreply (out of office).
CREATE TABLE addresses (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'person',
  persona_id TEXT,
  org TEXT,
  delivery TEXT NOT NULL DEFAULT 'ok',
  autoreply_body TEXT
) WITHOUT ROWID;

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  notes TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, email)
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  subject TEXT NOT NULL,
  last_at TEXT NOT NULL
);
CREATE INDEX threads_owner ON threads(owner_id, last_at);

-- System state is columns (Gmail's system labels); user labels are message_labels.
-- category applies to inbox mail: primary | social | promotions | updates.
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  message_id TEXT NOT NULL,              -- RFC 5322 Message-ID, shared by all copies of one email
  in_reply_to TEXT,
  from_name TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL,
  to_addrs TEXT NOT NULL DEFAULT '[]',   -- JSON [{name, email}]
  cc_addrs TEXT NOT NULL DEFAULT '[]',
  bcc_addrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL,
  in_inbox INTEGER NOT NULL DEFAULT 0,
  is_sent INTEGER NOT NULL DEFAULT 0,
  is_draft INTEGER NOT NULL DEFAULT 0,
  is_spam INTEGER NOT NULL DEFAULT 0,
  is_trash INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  is_important INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'primary',
  source TEXT,                           -- world item id / 'system' / 'site' (sent from the UI)
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id, sent_at);
CREATE INDEX messages_owner_inbox ON messages(owner_id, in_inbox, is_trash, is_spam, sent_at);
CREATE INDEX messages_owner_sent ON messages(owner_id, is_sent, sent_at);
CREATE INDEX messages_owner_time ON messages(owner_id, sent_at);
CREATE INDEX messages_msgid ON messages(message_id);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#888888',
  UNIQUE (owner_id, name)
);
CREATE TABLE message_labels (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, label_id)
) WITHOUT ROWID;
CREATE INDEX message_labels_label ON message_labels(label_id);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT                              -- under media/ (shared) or an upload URL
);
CREATE INDEX attachments_message ON attachments(message_id);

-- Filters run on new incoming mail (in id order); the first match does not stop later ones.
CREATE TABLE filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  match_from TEXT NOT NULL DEFAULT '',
  match_to TEXT NOT NULL DEFAULT '',
  match_subject TEXT NOT NULL DEFAULT '',
  match_words TEXT NOT NULL DEFAULT '',
  add_label_id INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  skip_inbox INTEGER NOT NULL DEFAULT 0,
  mark_read INTEGER NOT NULL DEFAULT 0,
  star INTEGER NOT NULL DEFAULT 0,
  trash INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE messages_fts USING fts5(subject, body, from_name, from_email, to_text, content='', contentless_delete=1, tokenize='unicode61');
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, body, from_name, from_email, to_text)
  VALUES (new.id, new.subject, new.body, new.from_name, new.from_email, new.to_addrs || ' ' || new.cc_addrs);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF subject, body, from_name, from_email, to_addrs, cc_addrs ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = old.id;
  INSERT INTO messages_fts(rowid, subject, body, from_name, from_email, to_text)
  VALUES (new.id, new.subject, new.body, new.from_name, new.from_email, new.to_addrs || ' ' || new.cc_addrs);
END;
