// SQLite storage using Node's built-in driver (node:sqlite, Node >= 22.5) — no native install needed.
// All SQL lives in src/db/*.js repositories, so moving to PostgreSQL/TimescaleDB later
// means re-implementing those files only; services and routes stay the same.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  // v1: device registry, channels, readings, ingest log
  `
  CREATE TABLE devices (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    type           TEXT,
    location       TEXT,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    api_key_hash   TEXT NOT NULL UNIQUE,
    api_key_hint   TEXT NOT NULL,
    auto_channels  INTEGER NOT NULL DEFAULT 1,
    payload_format TEXT NOT NULL DEFAULT 'json',
    binary_layout  TEXT,
    metadata       TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    last_seen_at   INTEGER
  ) STRICT;

  CREATE TABLE channels (
    device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL,
    name       TEXT,
    unit       TEXT NOT NULL DEFAULT '',
    scale      REAL NOT NULL DEFAULT 1,
    offset     REAL NOT NULL DEFAULT 0,
    min_valid  REAL,
    max_valid  REAL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, channel)
  ) STRICT;

  CREATE TABLE readings (
    device_id TEXT NOT NULL,
    channel   TEXT NOT NULL,
    ts        INTEGER NOT NULL,   -- epoch milliseconds (UTC)
    value     REAL NOT NULL,      -- engineering value after scale/offset
    raw       REAL,               -- original raw value, if it differed
    PRIMARY KEY (device_id, channel, ts),
    FOREIGN KEY (device_id, channel) REFERENCES channels(device_id, channel) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX idx_readings_ts ON readings(ts);

  CREATE TABLE ingest_log (
    id           INTEGER PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    received_at  INTEGER NOT NULL,
    source       TEXT NOT NULL,
    accepted     INTEGER NOT NULL,
    duplicates   INTEGER NOT NULL,
    rejected     INTEGER NOT NULL,
    reasons      TEXT
  ) STRICT;
  CREATE INDEX idx_ingest_log_device ON ingest_log(device_id, received_at);
  `
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let version = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  while (version < MIGRATIONS.length) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
    });
  }
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * @param {string} [file]  path to the database file, or ':memory:' (tests). Default: $DB_PATH or ./data/sensors.db
 */
function openDatabase(file = process.env.DB_PATH || path.join(process.cwd(), 'data', 'sensors.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');     // readers don't block the ingest writer
    db.exec('PRAGMA synchronous = NORMAL');
  }
  migrate(db);
  return db;
}

module.exports = { openDatabase, transaction };
