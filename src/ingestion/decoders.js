// Payload decoders: turn whatever a device sends into rows of { channel, timestamp?, raw, unit? }.
// Scale/offset and validation are applied later by the ingest service using the device registry.
//
// JSON — any of these shapes (single object or array of them):
//   Long:    { "channel": "power", "value": 1234, "timestamp": "..." }      (alias: sensorId, raw)
//   Compact: { "ts": 1790000000, "values": { "power": 1234, "temp": 22.1 } }
//   Flat:    { "ts": 1790000000, "power": 1234, "temp": 22.1 }             (every numeric field is a channel)
//   Wrapped: { "readings": [ ...any of the above... ] }
// CSV — long (timestamp,channel,value[,unit]) or wide (timestamp,power,temp,...) with a header row.
// Binary — fixed-size records described by the device's binaryLayout, sent as
//   application/octet-stream, a hex string, or JSON { "data": "<base64 or hex>" }.

const { badRequest } = require('../errors');

const TIMESTAMP_KEYS = ['timestamp', 'ts', 'time', 't', 'datetime', 'date'];
const CHANNEL_KEYS = ['channel', 'sensorid', 'sensor_id', 'sensor', 'ch'];
const VALUE_KEYS = ['value', 'val', 'v', 'reading', 'raw', 'adc'];
const IGNORED_KEYS = ['deviceid', 'device_id', 'device', 'id', 'apikey', 'api_key', 'key', 'seq', 'unit'];

const BINARY_TYPES = {
  int8: [1, 'readInt8'], uint8: [1, 'readUInt8'],
  int16be: [2, 'readInt16BE'], int16le: [2, 'readInt16LE'], uint16be: [2, 'readUInt16BE'], uint16le: [2, 'readUInt16LE'],
  int32be: [4, 'readInt32BE'], int32le: [4, 'readInt32LE'], uint32be: [4, 'readUInt32BE'], uint32le: [4, 'readUInt32LE'],
  float32be: [4, 'readFloatBE'], float32le: [4, 'readFloatLE'], float64be: [8, 'readDoubleBE'], float64le: [8, 'readDoubleLE']
};

const findKey = (obj, keys) => Object.keys(obj).find(k => keys.includes(k.toLowerCase()));

function decodeObject(obj, out) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw badRequest('Each reading must be a JSON object');

  if (Array.isArray(obj.readings)) { obj.readings.forEach(r => decodeObject(r, out)); return; }

  const tsKey = findKey(obj, TIMESTAMP_KEYS);
  const timestamp = tsKey ? obj[tsKey] : undefined;

  // Long form: one channel per object
  const chKey = findKey(obj, CHANNEL_KEYS);
  if (chKey) {
    const vKey = findKey(obj, VALUE_KEYS);
    out.push({ channel: String(obj[chKey]), timestamp, raw: vKey ? obj[vKey] : undefined, unit: obj.unit });
    return;
  }

  // Compact form: { ts, values: { ch: v } }
  if (obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values)) {
    for (const [channel, raw] of Object.entries(obj.values)) out.push({ channel, timestamp, raw });
    return;
  }

  // Flat form: every other numeric (or numeric-string / null) field is a channel
  let found = 0;
  for (const [key, raw] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (key === tsKey || IGNORED_KEYS.includes(k)) continue;
    if (typeof raw === 'number' || raw === null || (typeof raw === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(raw))) {
      out.push({ channel: key, timestamp, raw });
      found++;
    }
  }
  if (!found) throw badRequest('Reading has no channel values');
}

function decodeJson(body) {
  const out = [];
  (Array.isArray(body) ? body : [body]).forEach(item => decodeObject(item, out));
  return out;
}

function decodeCsv(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) throw badRequest('CSV must have a header row and at least one data row');
  const first = lines[0];
  const delimiter = first.includes('\t') ? '\t' : (first.includes(';') && !first.includes(',') ? ';' : ',');
  const headers = first.split(delimiter).map(h => h.trim());
  const lower = headers.map(h => h.toLowerCase());
  const tsIdx = lower.findIndex(h => TIMESTAMP_KEYS.includes(h));
  const chIdx = lower.findIndex(h => CHANNEL_KEYS.includes(h));
  const vIdx = lower.findIndex(h => VALUE_KEYS.includes(h));
  const unitIdx = lower.indexOf('unit');

  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map(c => c.trim());
    const timestamp = tsIdx >= 0 ? cells[tsIdx] : undefined;
    if (chIdx >= 0 && vIdx >= 0) {
      out.push({ channel: cells[chIdx], timestamp, raw: cells[vIdx], unit: unitIdx >= 0 ? cells[unitIdx] : undefined });
    } else {
      headers.forEach((h, i) => {
        if (i === tsIdx || IGNORED_KEYS.includes(lower[i])) return;
        out.push({ channel: h, timestamp, raw: cells[i] });
      });
    }
  }
  return out;
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  let s = payload;
  if (s && typeof s === 'object' && typeof s.data === 'string') s = s.data;
  if (typeof s !== 'string') throw badRequest('Binary payload must be raw bytes, a hex string, or { "data": "<base64|hex>" }');
  s = s.trim().replace(/^0x/i, '').replace(/[\s:]/g, '');
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return Buffer.from(s, 'base64');
  throw badRequest('Binary payload is neither valid hex nor base64');
}

function decodeBinary(payload, layout) {
  if (!layout) throw badRequest('Device has no binaryLayout configured');
  const buf = toBuffer(payload);
  const tsSize = layout.timestamp ? 4 : 0;
  const recordSize = tsSize + layout.fields.reduce((n, f) => n + BINARY_TYPES[f.type][0], 0);
  if (!buf.length || buf.length % recordSize !== 0) {
    throw badRequest(`Binary payload is ${buf.length} bytes; expected a multiple of the ${recordSize}-byte record size`);
  }
  const out = [];
  for (let off = 0; off < buf.length; off += recordSize) {
    let pos = off;
    let timestamp;
    if (layout.timestamp) {
      timestamp = layout.timestamp.type === 'uint32le' ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
      pos += 4;
    }
    for (const f of layout.fields) {
      const [size, reader] = BINARY_TYPES[f.type];
      out.push({ channel: f.channel, timestamp, raw: buf[reader](pos) });
      pos += size;
    }
  }
  return out;
}

/**
 * @param {*} payload  parsed JSON, a string (CSV / hex), or a Buffer
 * @param {{ payloadFormat: string, binaryLayout?: object }} device
 */
function decodePayload(payload, device) {
  if (payload === undefined || payload === null || payload === '' || (Buffer.isBuffer(payload) && !payload.length)) {
    throw badRequest('Empty payload');
  }
  if (device.payloadFormat === 'binary') return decodeBinary(payload, device.binaryLayout);

  if (Buffer.isBuffer(payload)) payload = payload.toString('utf8');
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { payload = JSON.parse(trimmed); } catch { throw badRequest('Payload looks like JSON but could not be parsed'); }
    } else {
      return decodeCsv(trimmed);
    }
  }
  return decodeJson(payload);
}

module.exports = { decodePayload, decodeJson, decodeCsv, decodeBinary, BINARY_TYPES };
