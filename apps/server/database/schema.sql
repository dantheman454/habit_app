PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','skipped')) DEFAULT 'pending',
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  completed_dates TEXT NULL,
  skipped_dates TEXT NULL,
  context TEXT CHECK(context IN ('school', 'personal', 'work')) DEFAULT 'personal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NULL,
  start_time TEXT NULL,
  end_time TEXT NULL,
  location TEXT NULL,
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  context TEXT CHECK(context IN ('school', 'personal', 'work')) DEFAULT 'personal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NULL,
  entity_id INTEGER NULL,
  payload TEXT NULL
);

-- Durable idempotency cache for apply responses
CREATE TABLE IF NOT EXISTS idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  ts TEXT NOT NULL,
  UNIQUE(idempotency_key, request_hash)
);

-- Batch recording for propose-only pipeline with undo
CREATE TABLE IF NOT EXISTS op_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT UNIQUE,
  ts TEXT
);

CREATE TABLE IF NOT EXISTS op_batch_ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT,
  action TEXT,
  op_json TEXT,
  before_json TEXT,
  after_json TEXT,
  FOREIGN KEY(batch_id) REFERENCES op_batches(id) ON DELETE CASCADE
);

-- Habits tables
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  started_on TEXT NULL,
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  weekly_target_count INTEGER NULL,
  context TEXT CHECK(context IN ('school', 'personal', 'work')) DEFAULT 'personal',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  done INTEGER NOT NULL CHECK(done IN (0,1)) DEFAULT 1,
  note TEXT NULL,
  UNIQUE(habit_id, date),
  FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
);

-- Optional linking table for future many-to-many relations
CREATE TABLE IF NOT EXISTS habit_links (
  habit_id INTEGER NOT NULL,
  kind TEXT CHECK(kind IN ('task','event')) NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY(habit_id, kind, entity_id),
  FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
);

-- FTS5 virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, notes, content='tasks', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, notes, location, content='events', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS habits_fts USING fts5(
  title, notes, content='habits', content_rowid='id'
);

-- FTS5 triggers for tasks
CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;

-- FTS5 triggers for events
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, title, notes, location) VALUES (new.id, new.title, new.notes, new.location);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
  INSERT INTO events_fts(rowid, title, notes, location) VALUES (new.id, new.title, new.notes, new.location);
END;


-- FTS5 triggers for habits
CREATE TRIGGER IF NOT EXISTS habits_ai AFTER INSERT ON habits BEGIN
  INSERT INTO habits_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS habits_ad AFTER DELETE ON habits BEGIN
  INSERT INTO habits_fts(habits_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS habits_au AFTER UPDATE ON habits BEGIN
  INSERT INTO habits_fts(habits_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
  INSERT INTO habits_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;


