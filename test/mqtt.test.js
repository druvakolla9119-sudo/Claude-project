const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { openDatabase } = require('../src/db/database');
const { createServices } = require('../src/services');
const { startMqttBridge } = require('../src/ingestion/mqttBridge');

// Stand-in for the "mqtt" package: records subscriptions and publishes
function fakeMqtt() {
  const client = new EventEmitter();
  client.subscribed = []; client.published = [];
  client.subscribe = t => client.subscribed.push(t);
  client.publish = (topic, msg) => client.published.push({ topic, msg: JSON.parse(msg) });
  return { connect: () => client, client };
}

test('MQTT bridge ingests telemetry and acknowledges', () => {
  const services = createServices(openDatabase(':memory:'));
  services.registry.create({ id: 'esp32-7', name: 'ESP32' });
  const mqtt = fakeMqtt();
  startMqttBridge({ url: 'mqtt://broker', mqttLib: mqtt, logger: { log() {}, error() {} }, ...services });

  mqtt.client.emit('connect');
  assert.deepStrictEqual(mqtt.client.subscribed, ['devices/+/telemetry']);

  mqtt.client.emit('message', 'devices/esp32-7/telemetry', Buffer.from('{"power": 820, "temp": 24.5}'));
  assert.strictEqual(mqtt.client.published[0].topic, 'devices/esp32-7/ack');
  assert.strictEqual(mqtt.client.published[0].msg.accepted, 2);

  mqtt.client.emit('message', 'devices/unknown/telemetry', Buffer.from('{"power": 1}'));
  assert.strictEqual(mqtt.client.published[1].msg.status, 404);

  services.registry.update('esp32-7', { status: 'disabled' });
  mqtt.client.emit('message', 'devices/esp32-7/telemetry', Buffer.from('{"power": 1}'));
  assert.strictEqual(mqtt.client.published[2].msg.status, 403);
  assert.strictEqual(services.readings.query({}).length, 2);
});
