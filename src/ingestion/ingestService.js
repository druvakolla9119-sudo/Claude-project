// Ingest pipeline: decode -> map to registered channels -> scale/clean -> store -> log.
// Transport-independent: used by the HTTP endpoint, the MQTT bridge, and tests.

const { decodePayload } = require('./decoders');
const { normalizeReadings } = require('../processing/normalizer');
const { badRequest, tooLarge } = require('../errors');

const CHANNEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const DEFAULTS = {
  maxRowsPerRequest: 50_000,
  maxFutureSkewMs: 5 * 60_000,              // reject timestamps > 5 min ahead (bad device clock)
  maxAgeMs: 400 * 24 * 3_600_000,           // reject timestamps older than ~13 months
  maxRejectionDetails: 20
};

function createIngestService({ devices, readings, registry }, options = {}) {
  const opts = { ...DEFAULTS, ...options };

  /**
   * @param {Object} args
   * @param {Object} args.device       authenticated device (from registry.authenticate)
   * @param {*}      args.payload      JSON, CSV/hex string, or Buffer
   * @param {string} [args.source]     'http' | 'mqtt' | ...
   * @param {number} [args.receivedAt] server time (ms); used when the device sends no timestamp
   */
  function ingest({ device, payload, source = 'http', receivedAt = Date.now() }) {
    const rows = decodePayload(payload, device);
    if (!rows.length) throw badRequest('Payload contained no readings');
    if (rows.length > opts.maxRowsPerRequest) {
      throw tooLarge(`Payload has ${rows.length} readings; the limit is ${opts.maxRowsPerRequest} per request`);
    }

    const channels = new Map(registry.channels(device.id).map(c => [c.channel, c]));
    const rejected = [];
    const reject = (row, reason) => rejected.push({ channel: row.channel, timestamp: row.timestamp, reason });

    // 1. Resolve channels (auto-register new ones if the device allows it)
    const candidates = [];
    for (const row of rows) {
      let ch = channels.get(row.channel);
      if (!ch) {
        if (!device.autoChannels) { reject(row, `Unknown channel "${row.channel}"`); continue; }
        if (!CHANNEL_PATTERN.test(row.channel || '')) { reject(row, 'Invalid channel name'); continue; }
        ch = devices.upsertChannel({ deviceId: device.id, channel: row.channel, unit: typeof row.unit === 'string' ? row.unit : '' });
        channels.set(ch.channel, ch);
      }
      // Devices without a real-time clock can omit timestamps: use server receive time
      const timestamp = row.timestamp === undefined || row.timestamp === null || row.timestamp === '' ? receivedAt : row.timestamp;
      candidates.push({ timestamp, sensorId: ch.channel, unit: ch.unit, raw: row.raw, scale: ch.scale, offset: ch.offset });
    }

    // 2. Parse, scale and clean with the shared normalizer
    const { readings: clean, rejected: bad } = normalizeReadings(candidates, { defaultSensorId: '?' });
    bad.forEach(b => reject({ channel: b.row.sensorId, timestamp: b.row.timestamp }, b.reason));

    // 3. Channel limits and clock sanity
    const toStore = [];
    for (const r of clean) {
      const ch = channels.get(r.sensorId);
      const row = { channel: r.sensorId, timestamp: r.timestamp };
      if (r.time > receivedAt + opts.maxFutureSkewMs) { reject(row, 'Timestamp is in the future (check device clock)'); continue; }
      if (r.time < receivedAt - opts.maxAgeMs) { reject(row, 'Timestamp is too old'); continue; }
      if (ch.minValid !== null && r.value < ch.minValid) { reject(row, `Below channel minimum (${ch.minValid})`); continue; }
      if (ch.maxValid !== null && r.value > ch.maxValid) { reject(row, `Above channel maximum (${ch.maxValid})`); continue; }
      const scaled = ch.scale !== 1 || ch.offset !== 0;
      const rawNumber = scaled ? (r.value - ch.offset) / ch.scale : null;
      toStore.push({ deviceId: device.id, channel: r.sensorId, time: r.time, value: r.value, raw: scaled ? Number(rawNumber.toPrecision(12)) : null });
    }

    // 4. Store, update last-seen, log
    const { inserted, duplicates } = readings.insertMany(toStore);
    // In-batch duplicates are rejected by the normalizer; count them with DB duplicates
    const batchDuplicates = rejected.filter(r => r.reason === 'Duplicate reading').length;
    const realRejected = rejected.filter(r => r.reason !== 'Duplicate reading');

    const reasons = {};
    realRejected.forEach(r => { reasons[r.reason] = (reasons[r.reason] || 0) + 1; });

    if (inserted > 0) devices.touch(device.id, receivedAt);
    readings.log({
      deviceId: device.id, receivedAt, source,
      accepted: inserted, duplicates: duplicates + batchDuplicates, rejected: realRejected.length, reasons
    });

    return {
      deviceId: device.id,
      received: rows.length,
      accepted: inserted,
      duplicates: duplicates + batchDuplicates,
      rejected: realRejected.length,
      rejectionReasons: reasons,
      rejections: realRejected.slice(0, opts.maxRejectionDetails)
    };
  }

  return { ingest };
}

module.exports = { createIngestService };
