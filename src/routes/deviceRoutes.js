// Admin API for the device registry and stored readings.
const express = require('express');
const { wrap } = require('./middleware');
const { badRequest } = require('../errors');

function deviceRoutes({ registry, readings }) {
  const r = express.Router();

  r.get('/', wrap((req, res) => res.json({ devices: registry.list() })));

  r.post('/', wrap((req, res) => {
    const { device, apiKey } = registry.create(req.body || {});
    res.status(201).json({ device, apiKey, note: 'Store this API key now; it cannot be shown again.' });
  }));

  r.get('/:id', wrap((req, res) => {
    const device = registry.get(req.params.id);
    res.json({ device, latest: readings.latest(device.id), recentIngests: readings.recentLog(device.id, 10) });
  }));

  r.patch('/:id', wrap((req, res) => res.json({ device: registry.update(req.params.id, req.body || {}) })));

  r.delete('/:id', wrap((req, res) => { registry.remove(req.params.id); res.status(204).end(); }));

  r.post('/:id/rotate-key', wrap((req, res) => {
    const { device, apiKey } = registry.rotateKey(req.params.id);
    res.json({ device, apiKey, note: 'The previous key no longer works.' });
  }));

  r.put('/:id/channels/:channel', wrap((req, res) => {
    res.json({ channel: registry.setChannel(req.params.id, { ...(req.body || {}), channel: req.params.channel }) });
  }));

  r.delete('/:id/channels/:channel', wrap((req, res) => {
    registry.removeChannel(req.params.id, req.params.channel);
    res.status(204).end();
  }));

  // GET /api/devices/:id/readings?channel=power&from=2026-09-01&to=2026-09-02&limit=1000
  r.get('/:id/readings', wrap((req, res) => {
    const device = registry.get(req.params.id);
    const time = (v, what) => {
      if (v === undefined) return undefined;
      const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
      if (!Number.isFinite(ms)) throw badRequest(`${what} must be an ISO date or epoch milliseconds`);
      return ms;
    };
    const limit = Math.min(Number(req.query.limit) || 1000, 100_000);
    const rows = readings.query({
      deviceIds: [device.id],
      channels: req.query.channel ? String(req.query.channel).split(',') : undefined,
      from: time(req.query.from, 'from'),
      to: time(req.query.to, 'to'),
      limit
    });
    res.json({
      deviceId: device.id,
      count: rows.length,
      readings: rows.map(x => ({ channel: x.channel, unit: x.unit, timestamp: new Date(x.ts).toISOString(), value: x.value }))
    });
  }));

  return r;
}

module.exports = { deviceRoutes };
