-- Tally's sync store (Cloudflare D1). A group's id is its secret link; ids
-- for members and entries come from the clients, so things made offline
-- keep their identity when they sync. Entries are kept as JSON as the page
-- wrote them (after validation); deleting one only marks it. Deleting a whole
-- group removes its members and entries and blanks its row (name and currency
-- ''), keeping only the id so queued changes on phones can't bring it back.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  split TEXT -- the default split for new expenses, JSON {mode, parts}
);
-- Added after launch: ALTER TABLE groups ADD COLUMN split TEXT;
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS members_group ON members (group_id);
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  v INTEGER NOT NULL DEFAULT 0 -- the group version that last wrote it
);
-- Added after launch: ALTER TABLE entries ADD COLUMN v INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS entries_group ON entries (group_id);
CREATE INDEX IF NOT EXISTS entries_group_v ON entries (group_id, v);
