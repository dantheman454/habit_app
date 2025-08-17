PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NULL,
  time_of_day TEXT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','skipped')) DEFAULT 'pending',
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  completed_dates TEXT NULL,
  skipped_dates TEXT NULL,
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
  completed INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  completed_dates TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('active','completed','archived')) DEFAULT 'active',
  current_progress_value REAL NULL,
  target_progress_value REAL NULL,
  progress_unit TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Habits (similar to todos but must be repeating at API layer)
CREATE TABLE IF NOT EXISTS habits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  scheduled_for TEXT NULL,
  time_of_day TEXT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT '{"type":"none"}',
  completed_dates TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Habit link tables (organizational composition)
CREATE TABLE IF NOT EXISTS habit_todo_items (
  habit_id INTEGER NOT NULL,
  todo_id INTEGER NOT NULL,
  PRIMARY KEY (habit_id, todo_id),
  FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS habit_event_items (
  habit_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (habit_id, event_id),
  FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goal_todo_items (
  goal_id INTEGER NOT NULL,
  todo_id INTEGER NOT NULL,
  PRIMARY KEY (goal_id, todo_id),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (todo_id) REFERENCES todos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goal_event_items (
  goal_id INTEGER NOT NULL,
  event_id INTEGER NOT NULL,
  PRIMARY KEY (goal_id, event_id),
  FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS goal_hierarchy (
  parent_goal_id INTEGER NOT NULL,
  child_goal_id INTEGER NOT NULL,
  PRIMARY KEY (parent_goal_id, child_goal_id),
  FOREIGN KEY (parent_goal_id) REFERENCES goals(id) ON DELETE CASCADE,
  FOREIGN KEY (child_goal_id) REFERENCES goals(id) ON DELETE CASCADE
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

-- FTS5 virtual tables
CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
  title, notes, content='todos', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  title, notes, location, content='events', content_rowid='id'
);
CREATE VIRTUAL TABLE IF NOT EXISTS habits_fts USING fts5(
  title, notes, content='habits', content_rowid='id'
);

-- FTS5 triggers for todos
CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
END;
CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, title, notes) VALUES('delete', old.id, old.title, old.notes);
  INSERT INTO todos_fts(rowid, title, notes) VALUES (new.id, new.title, new.notes);
END;

-- FTS5 triggers for events
CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
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
CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
END;
CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
  INSERT INTO events_fts(events_fts, rowid, title, notes, location) VALUES('delete', old.id, old.title, old.notes, old.location);
  INSERT INTO events_fts(rowid, title, notes, location) VALUES (new.id, new.title, new.notes, new.location);
END;


