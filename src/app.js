// Wires storage, services and routes together. server.js only starts it.
const path = require('path');
const express = require('express');
const cors = require('cors');

const { createServices } = require('./services');
const { deviceRoutes } = require('./routes/deviceRoutes');
const { ingestRoutes } = require('./routes/ingestRoutes');
const { uploadReportRoutes, storedReportRoutes } = require('./routes/reportRoutes');
const { requireAdmin, errorHandler } = require('./routes/middleware');

/**
 * @param {Object} cfg
 * @param {import('node:sqlite').DatabaseSync} cfg.db
 * @param {string} cfg.adminToken
 * @param {number} [cfg.ingestPerMinute=600]
 */
function createApp({ db, adminToken, ingestPerMinute = 600, logger = console, services: provided }) {
  if (!adminToken) throw new Error('adminToken is required');
  const services = provided || createServices(db);
  const admin = requireAdmin(adminToken);

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

  // Device-facing (API key auth)
  app.use('/api/ingest', ingestRoutes({ ...services, perMinute: ingestPerMinute }));

  // Admin-facing (admin token)
  app.use('/api/devices', admin, express.json({ limit: '1mb' }), deviceRoutes(services));
  app.use('/api/reports/stored', admin, storedReportRoutes(services));

  // Upload-and-report (kept from v2; public for the demo dashboard)
  app.use('/api/reports', uploadReportRoutes());

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler(logger));

  app.locals.services = services;
  return app;
}

module.exports = { createApp };
