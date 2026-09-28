// SQL for devices and their channels. Rows are returned in camelCase.

const json = v => (v === null || v === undefined ? null : JSON.stringify(v));
const parse = v => (v ? JSON.parse(v) : null);

function toDevice(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    location: row.location,
    status: row.status,
    apiKeyHint: row.api_key_hint,
    autoChannels: row.auto_channels === 1,
    payloadFormat: row.payload_format,
    binaryLayout: parse(row.binary_layout),
    metadata: parse(row.metadata),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null
  };
}

function toChannel(row) {
  if (!row) return null;
  return {
    deviceId: row.device_id,
    channel: row.channel,
    name: row.name,
    unit: row.unit,
    scale: row.scale,
    offset: row.offset,
    minValid: row.min_valid,
    maxValid: row.max_valid
  };
}

// camelCase field -> [column, serializer]
const DEVICE_COLUMNS = {
  name: ['name', v => v],
  type: ['type', v => v ?? null],
  location: ['location', v => v ?? null],
  status: ['status', v => v],
  autoChannels: ['auto_channels', v => (v ? 1 : 0)],
  payloadFormat: ['payload_format', v => v],
  binaryLayout: ['binary_layout', json],
  metadata: ['metadata', json],
  apiKeyHash: ['api_key_hash', v => v],
  apiKeyHint: ['api_key_hint', v => v]
};

function createDeviceRepo(db) {
  const stmt = {
    insert: db.prepare(`INSERT INTO devices
      (id, name, type, location, status, api_key_hash, api_key_hint, auto_channels, payload_format, binary_layout, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare('SELECT * FROM devices WHERE id = ?'),
    getByKey: db.prepare('SELECT * FROM devices WHERE api_key_hash = ?'),
    list: db.prepare('SELECT * FROM devices ORDER BY id'),
    remove: db.prepare('DELETE FROM devices WHERE id = ?'),
    touch: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    channels: db.prepare('SELECT * FROM channels WHERE device_id = ? ORDER BY channel'),
    channel: db.prepare('SELECT * FROM channels WHERE device_id = ? AND channel = ?'),
    upsertChannel: db.prepare(`INSERT INTO channels (device_id, channel, name, unit, scale, offset, min_valid, max_valid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, channel) DO UPDATE SET
        name = excluded.name, unit = excluded.unit, scale = excluded.scale, offset = excluded.offset,
        min_valid = excluded.min_valid, max_valid = excluded.max_valid`),
    removeChannel: db.prepare('DELETE FROM channels WHERE device_id = ? AND channel = ?')
  };

  return {
    insert(d) {
      const now = Date.now();
      stmt.insert.run(d.id, d.name, d.type ?? null, d.location ?? null, d.status || 'active', d.apiKeyHash, d.apiKeyHint,
        d.autoChannels === false ? 0 : 1, d.payloadFormat || 'json', json(d.binaryLayout), json(d.metadata), now, now);
      return toDevice(stmt.get.get(d.id));
    },
    get: id => toDevice(stmt.get.get(id)),
    getByKeyHash: hash => toDevice(stmt.getByKey.get(hash)),
    list: () => stmt.list.all().map(toDevice),
    update(id, fields) {
      const sets = [], params = [];
      for (const [key, value] of Object.entries(fields)) {
        const col = DEVICE_COLUMNS[key];
        if (!col || value === undefined) continue;
        sets.push(`${col[0]} = ?`);
        params.push(col[1](value));
      }
      if (sets.length) {
        sets.push('updated_at = ?');
        params.push(Date.now(), id);
        db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      }
      return toDevice(stmt.get.get(id));
    },
    remove: id => stmt.remove.run(id).changes > 0,
    touch: (id, ts = Date.now()) => stmt.touch.run(ts, id),

    channels: deviceId => stmt.channels.all(deviceId).map(toChannel),
    channel: (deviceId, channel) => toChannel(stmt.channel.get(deviceId, channel)),
    upsertChannel(c) {
      stmt.upsertChannel.run(c.deviceId, c.channel, c.name ?? null, c.unit ?? '', c.scale ?? 1, c.offset ?? 0,
        c.minValid ?? null, c.maxValid ?? null, Date.now());
      return toChannel(stmt.channel.get(c.deviceId, c.channel));
    },
    removeChannel: (deviceId, channel) => stmt.removeChannel.run(deviceId, channel).changes > 0
  };
}

module.exports = { createDeviceRepo };
