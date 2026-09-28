// Checks that the payloads built by examples/esp32_smoke_sensor are accepted by the ingest pipeline.
// The bodies below are copied verbatim from a host-side run of the sketch (clean air -> fire ->
// network outage with buffering -> sensor unplugged -> recovery).
const test = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db/database');
const { createServices } = require('../src/services');

const RECEIVED_AT = 1790000300 * 1000;
const CHANNELS = [
  { channel: 'smoke_ppm', unit: 'ppm', minValid: 0, maxValid: 10000 },
  { channel: 'smoke_ppm_max', unit: 'ppm', minValid: 0, maxValid: 10000 },
  { channel: 'alarm', unit: '', minValid: 0, maxValid: 1 },
  { channel: 'rs_r0', unit: '' },
  { channel: 'sensor_fault', unit: '', minValid: 0, maxValid: 1 },
  { channel: 'rssi', unit: 'dBm' }
];
const BODIES = [
  '[{"ts":1790000095,"smoke_ppm":18.2,"smoke_ppm_max":18.2,"rs_r0":9.830,"alarm":0,"sensor_fault":0,"rssi":-61}]',
  '[{"ts":1790000133,"smoke_ppm":265.4,"smoke_ppm_max":677.3,"rs_r0":1.980,"alarm":1,"sensor_fault":0,"rssi":-61}]',
  '[{"ts":1790000163,"smoke_ppm":677.3,"smoke_ppm_max":677.3,"rs_r0":1.980,"alarm":1,"sensor_fault":0,"rssi":0},' +
  '{"ts":1790000223,"smoke_ppm":677.3,"smoke_ppm_max":677.3,"rs_r0":1.980,"alarm":1,"sensor_fault":1,"rssi":0},' +
  '{"ts":1790000253,"alarm":1,"sensor_fault":1,"rssi":0}]',
  '{"smoke_ppm":18.2,"smoke_ppm_max":18.2,"rs_r0":9.830,"alarm":0,"sensor_fault":0,"rssi":-61}'   // no NTP time yet
];

test('smoke sensor firmware payloads are stored, including buffered and fault-only reports', () => {
  const { registry, ingestService, readings } = createServices(openDatabase(':memory:'));
  const { device } = registry.create({ id: 'smoke-01', name: 'Smoke sensor', type: 'smoke-sensor', autoChannels: false, channels: CHANNELS });

  const results = BODIES.map(body => ingestService.ingest({ device, payload: body, receivedAt: RECEIVED_AT }));
  results.forEach(r => assert.strictEqual(r.rejected, 0, JSON.stringify(r.rejectionReasons)));
  assert.deepStrictEqual(results.map(r => r.accepted), [6, 6, 15, 6]);

  const alarms = readings.query({ deviceIds: ['smoke-01'], channels: ['alarm'] });
  assert.deepStrictEqual(alarms.map(r => r.value), [0, 1, 1, 1, 1, 0]);
  assert.strictEqual(alarms.at(-1).ts, RECEIVED_AT, 'report without ts uses the server receive time');

  // Retrying the same buffered batch after a lost HTTP response must not create duplicates
  const retry = ingestService.ingest({ device, payload: BODIES[2], receivedAt: RECEIVED_AT });
  assert.strictEqual(retry.accepted, 0);
  assert.strictEqual(retry.duplicates, 15);
});
