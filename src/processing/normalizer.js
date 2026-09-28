// Turns raw telemetry from any microcontroller / sensor into clean, uniform readings:
//   { sensorId, unit, timestamp (ISO string), time (ms epoch), value (number) }
//
// Accepted input shapes:
//   1. Array of objects      [{ timestamp, value, sensorId?, unit? }, ...]
//      - field aliases: ts/time/t, val/v/reading, id/sensor/device, u
//      - raw register values: { raw: 2048, scale: 0.01, offset: -40 }
//   2. CSV string            "timestamp,sensorId,value,unit\n2026-...,S1,22.4,C"
//      (header row required; column names use the same aliases)
//   3. Array of strings      ["2026-09-28T10:00:00Z,22.4", ...]  -> timestamp,value[,sensorId[,unit]]
//
// Every rejected row is kept with a reason so the report can show data quality.

const { badRequest } = require('../errors');

const DEFAULT_ERROR_CODES = [-999, -9999, 9999, 65535, -32768, 32767];

const ALIASES = {
  timestamp: ['timestamp', 'ts', 'time', 't', 'datetime', 'date'],
  value: ['value', 'val', 'v', 'reading', 'measurement'],
  sensorId: ['sensorid', 'sensor_id', 'sensor', 'id', 'deviceid', 'device_id', 'device', 'channel'],
  unit: ['unit', 'units', 'u'],
  raw: ['raw', 'adc', 'register'],
  scale: ['scale', 'gain', 'multiplier'],
  offset: ['offset', 'bias']
};

function pick(obj, field) {
  for (const key of Object.keys(obj)) {
    if (ALIASES[field].includes(key.toLowerCase().trim())) return obj[key];
  }
  return undefined;
}

// Accepts ISO strings, epoch seconds, epoch milliseconds, or Date objects.
function parseTimestamp(input) {
  if (input === undefined || input === null || input === '') return null;
  if (input instanceof Date) return isNaN(input) ? null : input.getTime();

  const asNumber = typeof input === 'number' ? input : (/^\d+(\.\d+)?$/.test(String(input).trim()) ? Number(input) : NaN);
  if (!isNaN(asNumber)) {
    // < 1e11 is almost certainly seconds (1e11 s is the year 5138)
    return asNumber < 1e11 ? Math.round(asNumber * 1000) : Math.round(asNumber);
  }

  const ms = Date.parse(String(input).trim());
  return isNaN(ms) ? null : ms;
}

function parseNumber(input) {
  if (typeof input === 'number') return input;
  if (typeof input !== 'string') return NaN;
  let s = input.trim();
  // "22,4" (European decimal) -> "22.4"; "1,234.5" (thousands separator) -> "1234.5"
  s = s.includes('.') ? s.replace(/,/g, '') : s.replace(/,/g, '.');
  const match = s.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/); // tolerate trailing units like "22.4C"
  const cleaned = match ? match[0] : '';
  return cleaned === '' ? NaN : Number(cleaned);
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes(';') && !lines[0].includes(',') ? ';' : (lines[0].includes('\t') ? '\t' : ',');
  const headers = lines[0].split(delimiter).map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(delimiter);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i].trim() : undefined; });
    return row;
  });
}

function parseLine(line) {
  const [timestamp, value, sensorId, unit] = String(line).split(/[,;\t]/).map(s => s.trim());
  return { timestamp, value, sensorId, unit };
}

function toRows(input) {
  if (typeof input === 'string') return parseCsv(input);
  if (!Array.isArray(input)) throw badRequest('Sensor data must be an array of readings or a CSV string.');
  return input.map(item => (typeof item === 'string' ? parseLine(item) : item));
}

/**
 * @param {Array|string} input  raw sensor payload
 * @param {Object} [options]
 * @param {string} [options.defaultSensorId='sensor-1']
 * @param {string} [options.defaultUnit='']
 * @param {number[]} [options.errorCodes]  sentinel values that mean "sensor error"
 * @param {Object} [options.validRange]  { [unit]: { min, max } } physically possible limits
 */
function normalizeReadings(input, options = {}) {
  const {
    defaultSensorId = 'sensor-1',
    defaultUnit = '',
    errorCodes = DEFAULT_ERROR_CODES,
    validRange = {}
  } = options;

  const rows = toRows(input);
  const readings = [];
  const rejected = [];
  const seen = new Set();

  rows.forEach((row, index) => {
    const reject = reason => rejected.push({ index, reason, row });

    if (!row || typeof row !== 'object') return reject('Row is not an object');

    const time = parseTimestamp(pick(row, 'timestamp'));
    if (time === null) return reject('Missing or invalid timestamp');

    let value = parseNumber(pick(row, 'value'));
    const raw = pick(row, 'raw');
    if (isNaN(value) && raw !== undefined) {
      const rawNum = parseNumber(raw);
      if (errorCodes.includes(rawNum)) return reject(`Sensor error code (${rawNum})`);
      const scale = parseNumber(pick(row, 'scale'));
      const offset = parseNumber(pick(row, 'offset'));
      value = rawNum * (isNaN(scale) ? 1 : scale) + (isNaN(offset) ? 0 : offset);
      if (Number.isFinite(value)) value = Number(value.toPrecision(12)); // strip float noise, e.g. 224 * 0.1
    }

    if (!Number.isFinite(value)) return reject('Missing or non-numeric value');
    if (errorCodes.includes(value)) return reject(`Sensor error code (${value})`);

    const sensorId = String(pick(row, 'sensorId') ?? defaultSensorId).trim() || defaultSensorId;
    const unit = String(pick(row, 'unit') ?? defaultUnit).trim();

    const range = validRange[unit];
    if (range && ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max))) {
      return reject(`Outside physical range for ${unit} (${value})`);
    }

    const key = `${sensorId}|${unit}|${time}`;
    if (seen.has(key)) return reject('Duplicate reading');
    seen.add(key);

    readings.push({ sensorId, unit, time, timestamp: new Date(time).toISOString(), value });
  });

  return { readings, rejected, totalRows: rows.length };
}

module.exports = { normalizeReadings, parseTimestamp, parseNumber, DEFAULT_ERROR_CODES };
