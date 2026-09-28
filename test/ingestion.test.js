// Run with: npm test   (uses an in-memory SQLite database)
const test = require('node:test');
const assert = require('node:assert');
const { openDatabase } = require('../src/db/database');
const { createServices } = require('../src/services');

function setup() {
  return createServices(openDatabase(':memory:'));
}
const NOW = Date.parse('2026-09-28T12:00:00Z');

test('registry: create device returns a one-time API key that authenticates', () => {
  const { registry } = setup();
  const { device, apiKey } = registry.create({ id: 'meter-01', name: 'Main meter', channels: [{ channel: 'power', unit: 'W' }] });
  assert.match(apiKey, /^sk_dev_/);
  assert.strictEqual(device.channels[0].unit, 'W');
  assert.strictEqual(registry.authenticate(apiKey).id, 'meter-01');
  assert.ok(!JSON.stringify(registry.get('meter-01')).includes(apiKey), 'key must not be stored or returned in plain text');
});

test('registry: validation, conflicts, disable, rotate key', () => {
  const { registry } = setup();
  assert.throws(() => registry.create({ id: 'bad id!', name: 'x' }), e => e.status === 400);
  assert.throws(() => registry.create({ id: 'a', name: '' }), e => e.status === 400);
  assert.throws(() => registry.create({ id: 'a', name: 'A', payloadFormat: 'binary' }), /binaryLayout is required/);
  const { apiKey } = registry.create({ id: 'a', name: 'A' });
  assert.throws(() => registry.create({ id: 'a', name: 'A' }), e => e.status === 409);

  registry.update('a', { status: 'disabled' });
  assert.throws(() => registry.authenticate(apiKey), e => e.status === 403);
  registry.update('a', { status: 'active' });

  const rotated = registry.rotateKey('a');
  assert.throws(() => registry.authenticate(apiKey), e => e.status === 401);
  assert.strictEqual(registry.authenticate(rotated.apiKey).id, 'a');
  assert.throws(() => registry.authenticate('nope'), e => e.status === 401);
});

test('ingest: flat JSON from a microcontroller, auto-created channels, server timestamp', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({ id: 'esp32-1', name: 'ESP32' });
  const r = ingestService.ingest({ device, payload: { power: 1250, temp: '22.4', fw: '1.2.3' }, receivedAt: NOW });
  assert.strictEqual(r.accepted, 2);
  assert.deepStrictEqual(registry.channels('esp32-1').map(c => c.channel), ['power', 'temp']);
  const rows = readings.query({ deviceIds: ['esp32-1'] });
  assert.strictEqual(rows[0].ts, NOW);
  assert.strictEqual(registry.get('esp32-1').lastSeenAt, new Date(NOW).toISOString());
});

test('ingest: channel scale/offset, limits and error codes', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({
    id: 'adc-1', name: 'ADC board', autoChannels: false,
    channels: [{ channel: 'temp', unit: 'C', scale: 0.01, offset: -40, minValid: -40, maxValid: 125 }]
  });
  const t = s => new Date(NOW - s * 1000).toISOString();
  const r = ingestService.ingest({
    device, receivedAt: NOW,
    payload: [
      { channel: 'temp', raw: 6240, timestamp: t(60) },   // 6240*0.01-40 = 22.4 C
      { channel: 'temp', raw: 65535, timestamp: t(50) },  // error code
      { channel: 'temp', raw: 20000, timestamp: t(40) },  // 160 C > max
      { channel: 'humidity', raw: 50, timestamp: t(30) }  // unknown channel, auto off
    ]
  });
  assert.strictEqual(r.accepted, 1);
  assert.strictEqual(r.rejected, 3);
  assert.deepStrictEqual(Object.keys(r.rejectionReasons).sort(),
    ['Above channel maximum (125)', 'Sensor error code (65535)', 'Unknown channel "humidity"']);
  const [row] = readings.query({ deviceIds: ['adc-1'] });
  assert.strictEqual(row.value, 22.4);
});

test('ingest: duplicates (retries) are not stored twice', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({ id: 'd', name: 'D' });
  const payload = { ts: Math.floor(NOW / 1000) - 60, values: { power: 100, voltage: 230 } };
  assert.strictEqual(ingestService.ingest({ device, payload, receivedAt: NOW }).accepted, 2);
  const again = ingestService.ingest({ device, payload, receivedAt: NOW });
  assert.strictEqual(again.accepted, 0);
  assert.strictEqual(again.duplicates, 2);
  assert.strictEqual(readings.query({}).length, 2);
});

test('ingest: clock sanity checks', () => {
  const { registry, ingestService } = setup();
  const { device } = registry.create({ id: 'd', name: 'D' });
  const r = ingestService.ingest({
    device, receivedAt: NOW,
    payload: [
      { channel: 'x', value: 1, timestamp: NOW + 3_600_000 },   // 1h in future
      { channel: 'x', value: 1, timestamp: 0 }                  // 1970 (RTC not set)
    ]
  });
  assert.strictEqual(r.rejected, 2);
  assert.deepStrictEqual(Object.keys(r.rejectionReasons).sort(), ['Timestamp is in the future (check device clock)', 'Timestamp is too old']);
});

test('ingest: CSV long and wide formats', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({ id: 'logger', name: 'Logger' });
  const long = 'timestamp,channel,value,unit\n2026-09-28T11:00:00Z,power,1000,W\n2026-09-28T11:15:00Z,power,1200,W';
  const wide = 'ts;power;temp\n2026-09-28T11:30:00Z;1100;21,5\n2026-09-28T11:45:00Z;900;21,7';
  assert.strictEqual(ingestService.ingest({ device, payload: long, receivedAt: NOW }).accepted, 2);
  assert.strictEqual(ingestService.ingest({ device, payload: wide, receivedAt: NOW }).accepted, 4);
  assert.strictEqual(registry.channels('logger').find(c => c.channel === 'power').unit, 'W');
  assert.deepStrictEqual(readings.query({ channels: ['temp'] }).map(r => r.value), [21.5, 21.7]);
});

test('ingest: binary records (hex, base64 and raw bytes)', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({
    id: 'lora-1', name: 'LoRa node', payloadFormat: 'binary',
    binaryLayout: { timestamp: { type: 'uint32be' }, fields: [{ channel: 'power', type: 'uint16be' }, { channel: 'temp', type: 'int16be' }] },
    channels: [{ channel: 'power', unit: 'W' }, { channel: 'temp', unit: 'C', scale: 0.1 }]
  });
  // two records: [ts u32][power u16][temp i16]
  const buf = Buffer.alloc(16);
  const ts = Math.floor(NOW / 1000) - 120;
  buf.writeUInt32BE(ts, 0); buf.writeUInt16BE(1500, 4); buf.writeInt16BE(-52, 6);   // -5.2 C
  buf.writeUInt32BE(ts + 60, 8); buf.writeUInt16BE(1600, 12); buf.writeInt16BE(224, 14);

  assert.strictEqual(ingestService.ingest({ device, payload: buf.toString('hex'), receivedAt: NOW }).accepted, 4);
  const temps = readings.query({ channels: ['temp'] }).map(r => r.value);
  assert.deepStrictEqual(temps, [-5.2, 22.4]);

  // same bytes as base64 in JSON and as a Buffer: all duplicates
  assert.strictEqual(ingestService.ingest({ device, payload: { data: buf.toString('base64') }, receivedAt: NOW }).duplicates, 4);
  assert.strictEqual(ingestService.ingest({ device, payload: buf, receivedAt: NOW }).duplicates, 4);

  assert.throws(() => ingestService.ingest({ device, payload: buf.subarray(0, 10), receivedAt: NOW }), /multiple of the 8-byte record size/);
});

test('ingest: limits and bad payloads', () => {
  const { registry, ingestService } = setup();
  const { device } = registry.create({ id: 'd', name: 'D' });
  assert.throws(() => ingestService.ingest({ device, payload: '' }), e => e.status === 400);
  assert.throws(() => ingestService.ingest({ device, payload: '{broken' }), /could not be parsed/);
  assert.throws(() => ingestService.ingest({ device, payload: { fw: 'x' } }), /no channel values/);
  const big = Array.from({ length: 50_001 }, (_, i) => ({ channel: 'x', value: 1, timestamp: NOW - i }));
  assert.throws(() => ingestService.ingest({ device, payload: big, receivedAt: NOW }), e => e.status === 413);
});

test('reports from stored history', () => {
  const { registry, ingestService, reportService } = setup();
  const { device } = registry.create({ id: 'meter-01', name: 'Meter', channels: [{ channel: 'power', unit: 'W' }] });
  // 2 kW for 4 hours, 15-minute samples, one spike
  const payload = Array.from({ length: 17 }, (_, i) => ({
    channel: 'power', timestamp: NOW - (16 - i) * 900_000, value: i === 8 ? 9000 : 2000
  }));
  ingestService.ingest({ device, payload, receivedAt: NOW });

  const report = reportService.fromStorage({ devices: 'meter-01', from: NOW - 5 * 3_600_000, to: NOW });
  const s = report.sensors[0];
  assert.strictEqual(s.sensorId, 'meter-01/power');
  assert.strictEqual(s.anomalyCount, 1);
  assert.strictEqual(s.energy.energyKwh, 9.75); // 8 kWh baseline + spike area 0.5 * 7 kW * 0.5 h
  assert.throws(() => reportService.fromStorage({ devices: 'nope' }), e => e.status === 404);
  assert.throws(() => reportService.fromStorage({ devices: 'meter-01', from: NOW - 100 * 86_400_000, to: NOW - 99 * 86_400_000 }), e => e.status === 404);
});

test('deleting a device removes its data; retention purge', () => {
  const { registry, ingestService, readings } = setup();
  const { device } = registry.create({ id: 'd', name: 'D' });
  ingestService.ingest({ device, payload: [{ channel: 'x', value: 1, timestamp: NOW - 10 * 86_400_000 }, { channel: 'x', value: 2, timestamp: NOW }], receivedAt: NOW });
  assert.strictEqual(readings.purgeBefore(NOW - 86_400_000), 1);
  registry.remove('d');
  assert.strictEqual(readings.query({}).length, 0);
});
