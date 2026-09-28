const crypto = require('crypto');
const { openDatabase } = require('./src/db/database');
const { createApp } = require('./src/app');
const { startMqttBridge } = require('./src/ingestion/mqttBridge');

const PORT = Number(process.env.PORT) || 3000;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 0; // 0 = keep forever

let adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ADMIN_TOKEN must be set in production.');
    process.exit(1);
  }
  adminToken = crypto.randomBytes(18).toString('base64url');
  console.warn(`ADMIN_TOKEN not set; using a temporary token for this run:\n  ${adminToken}\n`);
}

const db = openDatabase();
const app = createApp({ db, adminToken, ingestPerMinute: Number(process.env.INGEST_PER_MINUTE) || 600 });
const { registry, ingestService, readings } = app.locals.services;

const server = app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

let mqttClient = null;
if (process.env.MQTT_URL) {
  mqttClient = startMqttBridge({
    url: process.env.MQTT_URL,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    registry,
    ingestService
  });
}

if (RETENTION_DAYS > 0) {
  const purge = () => {
    const removed = readings.purgeBefore(Date.now() - RETENTION_DAYS * 86_400_000);
    if (removed) console.log(`Retention: removed ${removed} readings older than ${RETENTION_DAYS} days`);
  };
  purge();
  setInterval(purge, 6 * 3_600_000).unref();
}

function shutdown() {
  console.log('Shutting down...');
  if (mqttClient) mqttClient.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
