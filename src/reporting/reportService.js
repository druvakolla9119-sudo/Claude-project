// Builds reports from stored history (as opposed to data uploaded in the request).

const { processSensorData } = require('../processing/dataProcessor');
const { badRequest, notFound } = require('../errors');

const MAX_REPORT_ROWS = 2_000_000;

function parseTime(v, what) {
  if (v === undefined || v === null || v === '') return undefined;
  const ms = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest(`${what} must be an ISO date or epoch milliseconds`);
  return ms;
}

const list = v => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : undefined)?.map(s => s.trim()).filter(Boolean);

function createReportService({ readings, registry }) {
  /**
   * @param {Object} q  { devices, channels, from, to, options } — devices/channels as arrays or comma lists
   *                    default period: last 24 hours
   */
  function fromStorage(q = {}) {
    const to = parseTime(q.to, 'to') ?? Date.now();
    const from = parseTime(q.from, 'from') ?? to - 24 * 3_600_000;
    if (from > to) throw badRequest('from must be before to');

    const deviceIds = list(q.devices);
    deviceIds?.forEach(id => registry.get(id)); // 404 for unknown devices

    const rows = readings.query({ deviceIds, channels: list(q.channels), from, to, limit: MAX_REPORT_ROWS + 1 });
    if (!rows.length) throw notFound('No stored readings match this device/channel/period selection');
    const truncated = rows.length > MAX_REPORT_ROWS;
    if (truncated) rows.length = MAX_REPORT_ROWS;

    const processed = processSensorData(
      rows.map(r => ({ sensorId: `${r.deviceId}/${r.channel}`, unit: r.unit, timestamp: r.ts, value: r.value })),
      { ...(q.options || {}), errorCodes: [] } // stored values are already cleaned
    );
    processed.summary.requestedPeriod = { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
    if (truncated) processed.insights.unshift(`Report limited to the first ${MAX_REPORT_ROWS} readings; narrow the period for full coverage.`);
    return processed;
  }

  return { fromStorage };
}

module.exports = { createReportService };
