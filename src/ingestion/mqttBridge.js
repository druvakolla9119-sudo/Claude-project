// Optional MQTT ingestion. Devices publish to   devices/<deviceId>/telemetry
// and receive the ingest result on             devices/<deviceId>/ack
//
// Security model: the MQTT broker authenticates devices and its ACL must only allow
// each device to publish to its own topic (e.g. Mosquitto: "pattern write devices/%u/telemetry"
// with the device id as the MQTT username). This bridge trusts the device id in the topic,
// but still refuses devices that are not registered or are disabled.
//
// Requires the "mqtt" package (npm install mqtt). Enabled when MQTT_URL is set.

function startMqttBridge({ url, registry, ingestService, username, password, mqttLib, logger = console }) {
  let mqtt = mqttLib;
  if (!mqtt) {
    try { mqtt = require('mqtt'); } catch {
      logger.error('MQTT_URL is set but the "mqtt" package is not installed. Run: npm install mqtt');
      return null;
    }
  }

  const client = mqtt.connect(url, { username, password, clientId: `sensor-ingest-${process.pid}`, reconnectPeriod: 5000 });
  const TOPIC = /^devices\/([^/]+)\/telemetry$/;

  client.on('connect', () => {
    logger.log(`MQTT bridge connected to ${url}; subscribed to devices/+/telemetry`);
    client.subscribe('devices/+/telemetry', { qos: 1 });
  });
  client.on('error', err => logger.error('MQTT error:', err.message));

  client.on('message', (topic, message) => {
    const match = TOPIC.exec(topic);
    if (!match) return;
    const deviceId = match[1];
    let result;
    try {
      const device = registry.get(deviceId);
      if (device.status !== 'active') throw Object.assign(new Error(`Device "${deviceId}" is disabled`), { status: 403 });
      // Binary devices get the raw bytes; others get the text payload (JSON or CSV)
      const payload = device.payloadFormat === 'binary' ? message : message.toString('utf8');
      result = ingestService.ingest({ device, payload, source: 'mqtt' });
    } catch (err) {
      result = { error: err.message, status: err.status || 500 };
      if (!err.status || err.status >= 500) logger.error(`MQTT ingest failed for ${deviceId}:`, err);
    }
    client.publish(`devices/${deviceId}/ack`, JSON.stringify(result), { qos: 0 });
  });

  return client;
}

module.exports = { startMqttBridge };
