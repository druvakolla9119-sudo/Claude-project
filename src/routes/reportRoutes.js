const express = require('express');
const { wrap } = require('./middleware');
const { processSensorData } = require('../processing/dataProcessor');
const { generatePDFReport } = require('../reporting/pdfGenerator');

function sendPdf(res, processed, title) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=sensor-report-${Date.now()}.pdf`);
  generatePDFReport(processed, res, { title });
}

// Accepts { sensorData: [...] | "csv text", options, title } as JSON, or a raw CSV body.
function readPayload(req) {
  if (typeof req.body === 'string') return { data: req.body, options: {} };
  return { data: req.body?.sensorData, options: req.body?.options || {}, title: req.body?.title };
}

// Reports on data uploaded in the request (no storage needed)
function uploadReportRoutes() {
  const r = express.Router();
  r.use(express.json({ limit: '20mb' }));
  r.use(express.text({ type: ['text/csv', 'text/plain'], limit: '20mb' }));

  r.post('/process', wrap((req, res) => {
    const { data, options } = readPayload(req);
    res.json(processSensorData(data, options));
  }));

  r.post('/generate', wrap((req, res) => {
    const { data, options, title } = readPayload(req);
    sendPdf(res, processSensorData(data, options), title);
  }));
  return r;
}

// Reports on stored history (admin).
//   GET /api/reports/stored?devices=meter-01,temp-01&channels=power&from=2026-09-01&to=2026-09-28&format=pdf|json
function storedReportRoutes({ reportService }) {
  const r = express.Router();
  r.get('/', wrap((req, res) => {
    const options = {};
    if (req.query.anomalyThreshold) options.anomalyThreshold = Number(req.query.anomalyThreshold);
    if (req.query.gapFactor) options.gapFactor = Number(req.query.gapFactor);
    const processed = reportService.fromStorage({ ...req.query, options });
    if (req.query.format === 'json') return res.json(processed);
    sendPdf(res, processed, req.query.title);
  }));
  return r;
}

module.exports = { uploadReportRoutes, storedReportRoutes };
