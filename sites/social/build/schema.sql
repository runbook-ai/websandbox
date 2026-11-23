-- websandbox social: additive extension of the forum schema (sites/forum/build/schema.sql).
-- Applied by migrate.js to a COPY of the forum base.db. Additive only: new tables, and new
-- nullable / defaulted columns on existing tables. No existing id, column or row changes,
-- so the converted WebArena forum tasks (ids in URLs, SQL in graders) grade as before.
-- Timestamps: 'YYYY-MM-DD HH:MM:SS' UTC text; no DEFAULT CURRENT_TIMESTAMP (kit rule 2).
-- See ../SCHEMA.md.

CREATE TABLE networks (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,               -- community | devblog | makers | micro
  title       TEXT NOT NULL,
  description TEXT,
  max_chars   INTEGER,                            -- body limit (micro: 280), NULL = none
  created_at  TEXT NOT NULL
);
INSERT INTO networks (id, name, title, description, max_chars, created_at) VALUES
  (1, 'community', 'Community', 'Topic communities with posts, nested comments, votes and flair', NULL, '2005-06-01 00:00:00'),
  (2, 'devblog', 'Devblog', 'Developer articles with tags, reactions and series', NULL, '2016-01-01 00:00:00'),
  (3, 'makers', 'Makers', 'Indie founders sharing products, milestones and lessons', NULL, '2017-01-01 00:00:00'),
  (4, 'micro', 'Micro', 'Short public posts, replies, quotes and follows', 280, '2006-03-01 00:00:00');

-- ---------------------------------------------------------------- columns on existing tables
-- Every existing row reads the default (forums/submissions = community, nothing else set).
ALTER TABLE forums ADD COLUMN network_id INTEGER DEFAULT 1;      -- networks.id
ALTER TABLE forums ADD COLUMN about TEXT;                        -- longer "About community" text (social frontend)
ALTER TABLE forums ADD COLUMN icon_color TEXT;                   -- avatar colour of the space (social frontend)

ALTER TABLE submissions ADD COLUMN network_id INTEGER DEFAULT 1;
ALTER TABLE submissions ADD COLUMN kind TEXT;                    -- NULL = classic link/text/image; 'article' | 'short' | 'thread-post'
ALTER TABLE submissions ADD COLUMN status TEXT DEFAULT 'published'; -- 'draft' | 'scheduled' | 'published'
ALTER TABLE submissions ADD COLUMN published_at TEXT;            -- NULL = created_at
ALTER TABLE submissions ADD COLUMN reading_time INTEGER;         -- minutes (articles)
ALTER TABLE submissions ADD COLUMN cover_image_id TEXT;          -- images.id
ALTER TABLE submissions ADD COLUMN series_id INTEGER;            -- series.id
ALTER TABLE submissions ADD COLUMN quote_of INTEGER;             -- submissions.id (micro quote posts)
ALTER TABLE submissions ADD COLUMN repost_of INTEGER;            -- submissions.id
ALTER TABLE submissions ADD COLUMN flair_id INTEGER;             -- flairs.id

ALTER TABLE users ADD COLUMN persona_id TEXT;                    -- world persona (never shown; generators and graders only)

ALTER TABLE notifications ADD COLUMN actor_id INTEGER;           -- who caused it (users.id)
ALTER TABLE notifications ADD COLUMN network_id INTEGER DEFAULT 1;

-- ---------------------------------------------------------------- per-network profiles
CREATE TABLE accounts (
  id                INTEGER PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  network_id        INTEGER NOT NULL REFERENCES networks(id),
  handle            TEXT NOT NULL,
  normalized_handle TEXT NOT NULL,                  -- lower(handle)
  display_name      TEXT,
  avatar_color      TEXT,
  bio               TEXT,
  joined_at         TEXT NOT NULL,
  UNIQUE (network_id, normalized_handle),
  UNIQUE (user_id, network_id)
);

-- ---------------------------------------------------------------- social graph
CREATE TABLE follows (
  network_id  INTEGER NOT NULL REFERENCES networks(id),
  follower_id INTEGER NOT NULL REFERENCES users(id),
  followee_id INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL,
  PRIMARY KEY (network_id, follower_id, followee_id)
) WITHOUT ROWID;
CREATE INDEX follows_followee ON follows(network_id, followee_id);
CREATE TABLE bookmarks (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, submission_id)
) WITHOUT ROWID;
CREATE TABLE reposts (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, submission_id)
) WITHOUT ROWID;
CREATE INDEX reposts_submission ON reposts(submission_id);

-- ---------------------------------------------------------------- reactions (typed, beside votes)
CREATE TABLE reactions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL,                        -- 'submission' | 'comment'
  target_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,                        -- 'like' | 'unicorn' | 'insightful' | 'funny' | 'fire' | ...
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, target_type, target_id, kind)
);
CREATE INDEX reactions_target ON reactions(target_type, target_id);
CREATE TABLE reaction_counts (
  target_type TEXT NOT NULL,
  target_id   INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  n           INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, kind)
) WITHOUT ROWID;
CREATE TRIGGER reactions_count_ai AFTER INSERT ON reactions BEGIN
  INSERT INTO reaction_counts (target_type, target_id, kind, n) VALUES (new.target_type, new.target_id, new.kind, 1)
    ON CONFLICT (target_type, target_id, kind) DO UPDATE SET n = n + 1; END;
CREATE TRIGGER reactions_count_ad AFTER DELETE ON reactions BEGIN
  UPDATE reaction_counts SET n = n - 1 WHERE target_type = old.target_type AND target_id = old.target_id AND kind = old.kind;
  DELETE FROM reaction_counts WHERE target_type = old.target_type AND target_id = old.target_id AND kind = old.kind AND n <= 0; END;

-- ---------------------------------------------------------------- tags, series
CREATE TABLE tags (
  id              INTEGER PRIMARY KEY,
  network_id      INTEGER NOT NULL REFERENCES networks(id),
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description     TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (network_id, normalized_name)
);
CREATE TABLE post_tags (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  tag_id        INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, tag_id)
) WITHOUT ROWID;
CREATE INDEX post_tags_tag ON post_tags(tag_id, submission_id);
CREATE TABLE tag_follows (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tag_id)
) WITHOUT ROWID;
CREATE TABLE series (
  id         INTEGER PRIMARY KEY,
  network_id INTEGER NOT NULL REFERENCES networks(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- space rules, flair
-- kind: 'text' (not machine-checkable) or a gradable kind; param depends on the kind:
--   no-self-promo    -                    no links to / mentions of the poster's own product, project or employer
--   flair-required   -                    a post must carry one of the space's flairs (enforced on submit)
--   min-account-age  days                 the account must be at least this old (enforced)
--   min-karma        points               user_stats karma (posts + comments) at least this (enforced)
--   no-links         -                    no link posts and no URLs in the body (enforced)
--   title-format     JSON {pattern, example}  title must match the regex (enforced)
CREATE TABLE space_rules (
  id          INTEGER PRIMARY KEY,
  forum_id    INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,                     -- 1-based display order
  title       TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'text',
  param       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX space_rules_forum ON space_rules(forum_id, position);
CREATE TABLE flairs (
  id       INTEGER PRIMARY KEY,
  forum_id INTEGER NOT NULL REFERENCES forums(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL,
  mod_only INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  UNIQUE (forum_id, name)
);
CREATE INDEX submissions_flair ON submissions(flair_id) WHERE flair_id IS NOT NULL;

-- ---------------------------------------------------------------- anti-spam
-- A user may make at most max_count actions (own submissions / comments in the network, or in
-- the one forum when forum_id is set) within window_seconds of the site clock. Rows with
-- account_age_below_days apply only to accounts younger than that (new-account gates).
CREATE TABLE posting_limits (
  id                     INTEGER PRIMARY KEY,
  network_id             INTEGER NOT NULL REFERENCES networks(id),
  forum_id               INTEGER REFERENCES forums(id) ON DELETE CASCADE,
  action                 TEXT NOT NULL,              -- 'submission' | 'comment'
  max_count              INTEGER NOT NULL,
  window_seconds         INTEGER NOT NULL,
  account_age_below_days INTEGER,
  message                TEXT
);

-- ---------------------------------------------------------------- time
-- Per-tenant clock: site_settings 'social_now' is the base "now" (the server's clock start);
-- tenants move it with /__rl/clock. scheduled_events fire (in fire_at, id order) once the
-- tenant clock passes fire_at; firing writes rows (a world reply lands, a notification arrives)
-- inside the tenant transaction, so a reset un-fires them.
CREATE TABLE scheduled_events (
  id         INTEGER PRIMARY KEY,
  network_id INTEGER NOT NULL DEFAULT 1,
  fire_at    TEXT NOT NULL,
  kind       TEXT NOT NULL,                          -- 'world.post' | 'world.comment' | 'notification' | 'vote'
  payload    TEXT NOT NULL,                          -- JSON
  fired_at   TEXT,
  result_id  INTEGER,                                -- row created by the event
  created_at TEXT NOT NULL
);
CREATE INDEX scheduled_events_due ON scheduled_events(fired_at, fire_at, id);

-- ---------------------------------------------------------------- world link (hidden)
-- One row per loaded world item spec: generators and graders only (never shown).
CREATE TABLE world_items (
  item_id     TEXT PRIMARY KEY,                      -- world spec id (c00000123)
  net         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  row_table   TEXT,                                  -- 'submissions' | 'comments' (NULL while scheduled)
  row_id      INTEGER,
  persona_id  TEXT NOT NULL,
  topic       TEXT,
  intent      TEXT,
  facts       TEXT,                                  -- JSON array
  event_id    TEXT,
  ts          TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX world_items_row ON world_items(row_table, row_id);

CREATE INDEX submissions_network_new ON submissions(network_id, id);
CREATE INDEX users_persona ON users(persona_id) WHERE persona_id IS NOT NULL;
CREATE INDEX notifications_unread ON notifications(user_id, read_at);
