// SQL for time-series readings and the ingest log.

const { transaction } = require('./database');

function createReadingRepo(db) {
  const stmt = {
    insert: db.prepare('INSERT OR IGNORE INTO readings (device_id, channel, ts, value, raw) VALUES (?, ?, ?, ?, ?)'),
    log: db.prepare(`INSERT INTO ingest_log (device_id, received_at, source, accepted, duplicates, rejected, reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    latest: db.prepare(`SELECT r.channel, r.ts, r.value, c.unit FROM readings r
      JOIN channels c ON c.device_id = r.device_id AND c.channel = r.channel
      WHERE r.device_id = ? AND r.ts = (SELECT MAX(ts) FROM readings WHERE device_id = r.device_id AND channel = r.channel)
      ORDER BY r.channel`),
    recentLog: db.prepare('SELECT * FROM ingest_log WHERE device_id = ? ORDER BY received_at DESC, id DESC LIMIT ?'),
    purge: db.prepare('DELETE FROM readings WHERE ts < ?')
  };

  return {
    /** @param {{deviceId, channel, time, value, raw?}[]} rows  @returns {{inserted:number, duplicates:number}} */
    insertMany(rows) {
      if (!rows.length) return { inserted: 0, duplicates: 0 };
      let inserted = 0;
      transaction(db, () => {
        for (const r of rows) {
          inserted += Number(stmt.insert.run(r.deviceId, r.channel, r.time, r.value, r.raw ?? null).changes);
        }
      });
      return { inserted, duplicates: rows.length - inserted };
    },

    /**
     * @param {Object} q
     * @param {string[]} [q.deviceIds]  @param {string[]} [q.channels]
     * @param {number} [q.from]  @param {number} [q.to]  epoch ms, inclusive
     * @param {number} [q.limit]
     */
    query({ deviceIds, channels, from, to, limit = 1_000_000 } = {}) {
      const where = [], params = [];
      if (deviceIds?.length) { where.push(`r.device_id IN (${deviceIds.map(() => '?').join(',')})`); params.push(...deviceIds); }
      if (channels?.length) { where.push(`r.channel IN (${channels.map(() => '?').join(',')})`); params.push(...channels); }
      if (from !== undefined) { where.push('r.ts >= ?'); params.push(from); }
      if (to !== undefined) { where.push('r.ts <= ?'); params.push(to); }
      params.push(limit);
      return db.prepare(`SELECT r.device_id AS deviceId, r.channel, r.ts, r.value, c.unit
        FROM readings r JOIN channels c ON c.device_id = r.device_id AND c.channel = r.channel
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.device_id, r.channel, r.ts LIMIT ?`).all(...params);
    },

    latest: deviceId => stmt.latest.all(deviceId).map(r => ({ ...r, timestamp: new Date(r.ts).toISOString() })),

    log(entry) {
      stmt.log.run(entry.deviceId, entry.receivedAt, entry.source, entry.accepted, entry.duplicates, entry.rejected,
        entry.reasons && Object.keys(entry.reasons).length ? JSON.stringify(entry.reasons) : null);
    },
    recentLog: (deviceId, limit = 20) => stmt.recentLog.all(deviceId, limit).map(r => ({
      receivedAt: new Date(r.received_at).toISOString(), source: r.source,
      accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected,
      reasons: r.reasons ? JSON.parse(r.reasons) : {}
    })),

    /** Data retention: delete readings older than the given epoch ms. */
    purgeBefore: ts => Number(stmt.purge.run(ts).changes)
  };
}

module.exports = { createReadingRepo };
