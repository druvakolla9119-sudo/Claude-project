// Device-facing ingestion endpoint.
//   POST /api/ingest   (X-API-Key: sk_dev_...)
//   Body: JSON, text/csv, text/plain (CSV or hex), or application/octet-stream (binary)
const express = require('express');
const { requireDevice, rateLimit, wrap } = require('./middleware');

function ingestRoutes({ registry, ingestService, perMinute }) {
  const r = express.Router();

  r.post('/',
    requireDevice(registry),
    rateLimit({ perMinute, keyFn: req => req.device.id }),
    express.json({ limit: '5mb', type: ['application/json', 'application/*+json'] }),
    express.text({ limit: '5mb', type: ['text/*', 'application/csv'] }),
    express.raw({ limit: '5mb', type: ['application/octet-stream'] }),
    wrap((req, res) => {
      const result = ingestService.ingest({ device: req.device, payload: req.body, source: 'http' });
      // 207-style signalling kept simple for firmware: 200 if anything stored or all duplicates, 422 if all rejected
      const status = result.accepted === 0 && result.duplicates === 0 && result.rejected > 0 ? 422 : 200;
      res.status(status).json(result);
    })
  );

  return r;
}

module.exports = { ingestRoutes };
