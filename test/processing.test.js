// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { processSensorData } = require('../src/processing/dataProcessor');
const { normalizeReadings } = require('../src/processing/normalizer');

test('original sample: flags only the real spike', () => {
  const data = [
    { timestamp: '2026-09-28T10:00:00Z', value: 22.4 },
    { timestamp: '2026-09-28T10:05:00Z', value: 23.1 },
    { timestamp: '2026-09-28T10:10:00Z', value: 85.6 },
    { timestamp: '2026-09-28T10:15:00Z', value: 21.8 },
    { timestamp: '2026-09-28T10:20:00Z', value: 22.9 }
  ];
  const r = processSensorData(data);
  assert.strictEqual(r.summary.anomalyCount, 1);
  assert.strictEqual(r.anomalies[0].value, 85.6);
  assert.strictEqual(r.anomalies[0].direction, 'high');
});

test('normal variation produces no anomalies (old threshold would flag the max)', () => {
  const data = [20, 21, 22, 23, 24, 22, 21].map((v, i) => ({ timestamp: i * 60, value: v }));
  assert.strictEqual(processSensorData(data).summary.anomalyCount, 0);
});

test('low outliers are flagged', () => {
  const data = [230, 231, 229, 0, 230, 232, 231].map((v, i) => ({ timestamp: i * 60, value: v, unit: 'V' }));
  const r = processSensorData(data);
  assert.strictEqual(r.summary.anomalyCount, 1);
  assert.strictEqual(r.anomalies[0].direction, 'low');
});

test('bad values are rejected, not averaged in', () => {
  const data = [
    { timestamp: 0, value: 10 }, { timestamp: 60, value: '11' }, { timestamp: 120, value: null },
    { timestamp: 180, value: 'NaN' }, { timestamp: 240, value: -999 }, { value: 12 }, { timestamp: 300, value: '12.5C' }
  ];
  const r = processSensorData(data);
  assert.strictEqual(r.summary.validReadings, 3);
  assert.strictEqual(r.summary.rejectedReadings, 4);
  assert.strictEqual(r.sensors[0].stats.average, 11.17);
});

test('large datasets do not overflow the stack', () => {
  const data = Array.from({ length: 500_000 }, (_, i) => ({ timestamp: i, value: Math.sin(i) }));
  const r = processSensorData(data);
  assert.strictEqual(r.summary.validReadings, 500_000);
  assert.ok(r.sensors[0].series.length <= 400);
});

test('sensors and units are analysed separately', () => {
  const data = [
    { timestamp: 0, sensorId: 'A', unit: 'C', value: 20 }, { timestamp: 60, sensorId: 'A', unit: 'C', value: 21 },
    { timestamp: 0, sensorId: 'B', unit: 'W', value: 1000 }, { timestamp: 60, sensorId: 'B', unit: 'W', value: 1000 }
  ];
  const r = processSensorData(data);
  assert.strictEqual(r.summary.sensorCount, 2);
  assert.strictEqual(r.sensors.find(s => s.sensorId === 'A').stats.average, 20.5);
});

test('power readings integrate to kWh', () => {
  // constant 2 kW for 3 hours = 6 kWh
  const data = [0, 1, 2, 3].map(h => ({ timestamp: h * 3600, value: 2000, unit: 'W' }));
  const e = processSensorData(data).sensors[0].energy;
  assert.strictEqual(e.energyKwh, 6);
  assert.strictEqual(e.peakDemandKw, 2);
});

test('cumulative meter handles resets', () => {
  const data = [100, 101, 102.5, 0.5, 1.5].map((v, i) => ({ timestamp: i * 900, value: v, unit: 'kWh' }));
  const e = processSensorData(data).sensors[0].energy;
  assert.strictEqual(e.energyKwh, 3.5);
  assert.strictEqual(e.meterResets, 1);
});

test('gaps are detected and not integrated across', () => {
  const times = [0, 60, 120, 180, 3780, 3840, 3900];
  const data = times.map(t => ({ timestamp: t, value: 1000, unit: 'W' }));
  const s = processSensorData(data).sensors[0];
  assert.strictEqual(s.dataQuality.gaps.length, 1);
  assert.strictEqual(s.dataQuality.typicalIntervalSec, 60);
  assert.strictEqual(s.energy.energyKwh, round(5 * 60 / 3600, 3)); // 5 one-minute intervals at 1 kW
});

test('CSV, line strings and raw register input', () => {
  const csv = 'timestamp;sensor;value;unit\n2026-09-28T10:00:00Z;S1;22,4;C\n2026-09-28T10:05:00Z;S1;23,1;C';
  assert.deepStrictEqual(normalizeReadings(csv).readings.map(r => r.value), [22.4, 23.1]);

  const lines = ['1790000000,5.5,dev1,A', '1790000060,5.7,dev1,A'];
  const l = normalizeReadings(lines).readings;
  assert.strictEqual(l[0].sensorId, 'dev1');
  assert.strictEqual(l[0].timestamp, '2026-09-21T14:13:20.000Z');

  const reg = normalizeReadings([{ ts: 0, raw: 2500, scale: 0.01, offset: -2 }, { ts: 60, raw: 65535, scale: 0.01 }]);
  assert.strictEqual(reg.readings[0].value, 23);
  assert.strictEqual(reg.rejected[0].reason, 'Sensor error code (65535)');
});

test('empty / fully invalid input throws a clear error', () => {
  assert.throws(() => processSensorData([]), /No sensor data/);
  assert.throws(() => processSensorData([{ value: 1 }]), /No valid readings.*timestamp/);
});

function round(n, d) { return Number(n.toFixed(d)); }
