// Turns normalized readings into high-level, per-sensor insights:
//   - statistics (single pass, safe for millions of readings)
//   - robust anomaly detection (modified z-score, flags both high and low outliers)
//   - data gaps / coverage
//   - energy metrics: kWh from power readings (W/kW) or cumulative meters (Wh/kWh)

const { normalizeReadings } = require('./normalizer');
const { badRequest } = require('../errors');

const DEFAULTS = {
  anomalyThreshold: 3.5, // modified z-score cut-off (Iglewicz & Hoaglin recommendation)
  gapFactor: 3,          // a gap is an interval > gapFactor x the typical interval
  maxAnomaliesPerSensor: 500
};

const POWER_UNITS = { w: 1 / 1000, kw: 1, mw: 1000 };          // multiply to get kW
const ENERGY_UNITS = { wh: 1 / 1000, kwh: 1, mwh: 1000 };      // multiply to get kWh

const round = (n, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);

function median(sorted) {
  if (!sorted.length) return NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function basicStats(readings) {
  let min = Infinity, max = -Infinity, sum = 0, sumSq = 0, minAt = null, maxAt = null;
  for (const r of readings) {
    sum += r.value;
    sumSq += r.value * r.value;
    if (r.value < min) { min = r.value; minAt = r.timestamp; }
    if (r.value > max) { max = r.value; maxAt = r.timestamp; }
  }
  const n = readings.length;
  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  return { count: n, mean, min, max, minAt, maxAt, stdDev: Math.sqrt(variance) };
}

// Modified z-score: M = 0.6745 * (x - median) / MAD.
// Unlike a mean/std-dev z-score, one huge spike can't hide itself by inflating the std-dev,
// and it works on small samples.
function detectAnomalies(readings, threshold, limit) {
  const values = readings.map(r => r.value).sort((a, b) => a - b);
  const med = median(values);
  const absDev = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = median(absDev);

  let scale;
  if (mad > 0) {
    scale = mad / 0.6745;
  } else {
    // More than half the readings are identical: fall back to mean absolute deviation.
    const meanAD = absDev.reduce((a, b) => a + b, 0) / absDev.length;
    if (meanAD === 0) return { anomalies: [], median: med, total: 0 };
    scale = meanAD * 1.253314;
  }

  const all = [];
  for (const r of readings) {
    const score = (r.value - med) / scale;
    if (Math.abs(score) > threshold) {
      all.push({
        sensorId: r.sensorId,
        unit: r.unit,
        timestamp: r.timestamp,
        value: r.value,
        direction: score > 0 ? 'high' : 'low',
        score: round(score, 1),
        deviation: round(r.value - med)
      });
    }
  }
  // Keep the most severe ones if there are too many
  const anomalies = all.length > limit
    ? [...all].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, limit).sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    : all;
  return { anomalies, median: med, total: all.length };
}

function detectGaps(readings, gapFactor) {
  if (readings.length < 3) return { typicalIntervalSec: null, gaps: [], coveragePct: 100 };

  const intervals = [];
  for (let i = 1; i < readings.length; i++) intervals.push(readings[i].time - readings[i - 1].time);
  const typical = median([...intervals].sort((a, b) => a - b));
  const limit = typical * gapFactor;

  const gaps = [];
  let missingMs = 0;
  for (let i = 1; i < readings.length; i++) {
    const dt = intervals[i - 1];
    if (typical > 0 && dt > limit) {
      gaps.push({
        from: readings[i - 1].timestamp,
        to: readings[i].timestamp,
        durationSec: Math.round(dt / 1000),
        missedReadings: Math.max(0, Math.round(dt / typical) - 1)
      });
      missingMs += dt - typical;
    }
  }
  const spanMs = readings[readings.length - 1].time - readings[0].time;
  const coveragePct = spanMs > 0 ? round(100 * (1 - missingMs / spanMs), 1) : 100;
  return { typicalIntervalSec: round(typical / 1000, 1), gaps, coveragePct, limitMs: limit };
}

// Power (W/kW): integrate over time with the trapezoidal rule, skipping gaps.
// Cumulative energy meter (Wh/kWh): consumption = sum of positive deltas (handles meter resets).
function energyMetrics(readings, unit, gapLimitMs) {
  const key = unit.toLowerCase();

  if (POWER_UNITS[key] !== undefined) {
    const toKw = POWER_UNITS[key];
    let kwh = 0;
    let peak = readings[0];
    for (let i = 1; i < readings.length; i++) {
      const a = readings[i - 1], b = readings[i];
      if (b.value > peak.value) peak = b;
      const dtMs = b.time - a.time;
      if (gapLimitMs && dtMs > gapLimitMs) continue; // don't guess across outages
      kwh += ((a.value + b.value) / 2) * toKw * (dtMs / 3_600_000);
    }
    const hours = (readings[readings.length - 1].time - readings[0].time) / 3_600_000;
    return {
      type: 'power',
      energyKwh: round(kwh, 3),
      averageKw: hours > 0 ? round(kwh / hours, 3) : null,
      peakDemandKw: round(peak.value * toKw, 3),
      peakDemandAt: peak.timestamp
    };
  }

  if (ENERGY_UNITS[key] !== undefined) {
    const toKwh = ENERGY_UNITS[key];
    let kwh = 0, resets = 0, peakDelta = 0, peakAt = null;
    for (let i = 1; i < readings.length; i++) {
      const delta = readings[i].value - readings[i - 1].value;
      if (delta < 0) { resets++; continue; }
      kwh += delta * toKwh;
      if (delta > peakDelta) { peakDelta = delta; peakAt = readings[i].timestamp; }
    }
    return {
      type: 'meter',
      energyKwh: round(kwh, 3),
      meterResets: resets,
      peakIntervalKwh: round(peakDelta * toKwh, 3),
      peakIntervalAt: peakAt
    };
  }

  return null;
}

// Down-sample for charts so the PDF stays small no matter how much data arrives.
function downsample(readings, maxPoints = 200) {
  if (readings.length <= maxPoints) return readings.map(r => ({ t: r.time, v: r.value }));
  const bucket = readings.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    const slice = readings.slice(Math.floor(i * bucket), Math.floor((i + 1) * bucket));
    // keep min and max of each bucket so spikes stay visible
    let lo = slice[0], hi = slice[0];
    for (const r of slice) { if (r.value < lo.value) lo = r; if (r.value > hi.value) hi = r; }
    (lo.time <= hi.time ? [lo, hi] : [hi, lo]).forEach(r => out.push({ t: r.time, v: r.value }));
  }
  return out;
}

function analyseSensor(sensorId, unit, readings, opts) {
  readings.sort((a, b) => a.time - b.time);
  const stats = basicStats(readings);
  // A cumulative meter only ever climbs, so outliers are found in the per-interval consumption.
  const isMeter = ENERGY_UNITS[unit.toLowerCase()] !== undefined;
  const anomalyInput = isMeter
    ? readings.slice(1).map((r, i) => ({ ...r, value: round(r.value - readings[i].value, 6) })).filter(r => r.value >= 0)
    : readings;
  const med = median(readings.map(r => r.value).sort((a, b) => a - b));
  const { anomalies, total } = anomalyInput.length
    ? detectAnomalies(anomalyInput, opts.anomalyThreshold, opts.maxAnomaliesPerSensor)
    : { anomalies: [], total: 0 };
  if (isMeter) anomalies.forEach(a => { a.basis = 'interval consumption'; });
  const gapInfo = detectGaps(readings, opts.gapFactor);
  const energy = energyMetrics(readings, unit, gapInfo.limitMs);
  delete gapInfo.limitMs;

  return {
    sensorId,
    unit,
    period: { start: readings[0].timestamp, end: readings[readings.length - 1].timestamp },
    stats: {
      count: stats.count,
      average: round(stats.mean),
      median: round(med),
      minimum: stats.min,
      minimumAt: stats.minAt,
      maximum: stats.max,
      maximumAt: stats.maxAt,
      stdDev: round(stats.stdDev)
    },
    anomalyCount: total,
    anomalies,
    dataQuality: gapInfo,
    energy,
    series: downsample(readings)
  };
}

function buildInsights(sensors, rejectedCount, totalRows) {
  const insights = [];
  if (rejectedCount > 0) {
    insights.push(`${rejectedCount} of ${totalRows} raw rows (${round(100 * rejectedCount / totalRows, 1)}%) were rejected as invalid.`);
  }
  for (const s of sensors) {
    const label = `${s.sensorId}${s.unit ? ` (${s.unit})` : ''}`;
    if (s.anomalyCount) {
      const highs = s.anomalies.filter(a => a.direction === 'high').length;
      const lows = s.anomalies.length - highs;
      insights.push(`${label}: ${s.anomalyCount} anomal${s.anomalyCount === 1 ? 'y' : 'ies'} (${highs} high, ${lows} low).`);
    }
    if (s.dataQuality.gaps.length) {
      insights.push(`${label}: ${s.dataQuality.gaps.length} data gap(s); coverage ${s.dataQuality.coveragePct}%.`);
    }
    if (s.energy) {
      insights.push(s.energy.type === 'power'
        ? `${label}: ${s.energy.energyKwh} kWh used, peak demand ${s.energy.peakDemandKw} kW at ${s.energy.peakDemandAt}.`
        : `${label}: ${s.energy.energyKwh} kWh consumed${s.energy.meterResets ? `, ${s.energy.meterResets} meter reset(s)` : ''}.`);
    }
  }
  if (!insights.length) insights.push('All sensors operated within normal range with no gaps detected.');
  return insights;
}

/**
 * @param {Array|string} rawInput  raw sensor payload (see normalizer.js for accepted shapes)
 * @param {Object} [options]  anomalyThreshold, gapFactor, plus any normalizer option
 */
function processSensorData(rawInput, options = {}) {
  if (!rawInput || (Array.isArray(rawInput) && !rawInput.length)) {
    throw badRequest('No sensor data provided.');
  }
  const opts = { ...DEFAULTS, ...options };

  const { readings, rejected, totalRows } = normalizeReadings(rawInput, opts);
  if (!readings.length) {
    const reasons = [...new Set(rejected.map(r => r.reason))].join('; ');
    throw badRequest(`No valid readings after cleaning${reasons ? `: ${reasons}` : ''}.`);
  }

  // Group by sensor + unit so different devices/quantities are never averaged together
  const groups = new Map();
  for (const r of readings) {
    const key = `${r.sensorId}\u0000${r.unit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const sensors = [...groups.entries()]
    .map(([key, list]) => { const [id, unit] = key.split('\u0000'); return analyseSensor(id, unit, list, opts); })
    .sort((a, b) => a.sensorId.localeCompare(b.sensorId) || a.unit.localeCompare(b.unit));

  const energySensors = sensors.filter(s => s.energy);
  const allTimes = readings.map(r => r.time);
  let start = Infinity, end = -Infinity;
  for (const t of allTimes) { if (t < start) start = t; if (t > end) end = t; }

  return {
    summary: {
      totalRows,
      validReadings: readings.length,
      rejectedReadings: rejected.length,
      sensorCount: sensors.length,
      anomalyCount: sensors.reduce((n, s) => n + s.anomalyCount, 0),
      gapCount: sensors.reduce((n, s) => n + s.dataQuality.gaps.length, 0),
      totalEnergyKwh: energySensors.length ? round(energySensors.reduce((n, s) => n + s.energy.energyKwh, 0), 3) : null,
      period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() }
    },
    insights: buildInsights(sensors, rejected.length, totalRows),
    sensors,
    anomalies: sensors.flatMap(s => s.anomalies),
    rejected: rejected.slice(0, 100).map(r => ({ index: r.index, reason: r.reason })),
    processedAt: new Date().toISOString()
  };
}

module.exports = { processSensorData, detectAnomalies, detectGaps, energyMetrics };
