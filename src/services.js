// Builds the storage repositories and services on top of an open database.
// Kept separate from app.js so scripts and tests can use it without Express.
const { createDeviceRepo } = require('./db/deviceRepo');
const { createReadingRepo } = require('./db/readingRepo');
const { createDeviceRegistry } = require('./registry/deviceRegistry');
const { createIngestService } = require('./ingestion/ingestService');
const { createReportService } = require('./reporting/reportService');

function createServices(db, options = {}) {
  const devices = createDeviceRepo(db);
  const readings = createReadingRepo(db);
  const registry = createDeviceRegistry({ devices });
  const ingestService = createIngestService({ devices, readings, registry }, options.ingest);
  const reportService = createReportService({ readings, registry });
  return { devices, readings, registry, ingestService, reportService };
}

module.exports = { createServices };
