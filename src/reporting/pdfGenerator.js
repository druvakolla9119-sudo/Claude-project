const PDFDocument = require('pdfkit');

const COLORS = {
  text: '#1f2933',
  muted: '#616e7c',
  line: '#d9dee4',
  accent: '#2563eb',
  high: '#dc2626',
  low: '#d97706',
  ok: '#16a34a',
  panel: '#f3f5f8'
};

const MAX_ANOMALY_ROWS = 25;
const MAX_GAP_ROWS = 10;

const fmtTime = iso => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC') : '-');
const fmt = (n, unit = '') => (n === null || n === undefined ? '-' : `${n}${unit ? ` ${unit}` : ''}`);

function ensureSpace(doc, height) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function sectionTitle(doc, text) {
  ensureSpace(doc, 40);
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(COLORS.text).text(text, doc.page.margins.left);
  const y = doc.y + 2;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.moveDown(0.5);
}

// Row of KPI tiles
function kpiTiles(doc, tiles) {
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const gap = 8;
  const w = (width - gap * (tiles.length - 1)) / tiles.length;
  const h = 48;
  ensureSpace(doc, h + 10);
  const top = doc.y;
  tiles.forEach((t, i) => {
    const x = left + i * (w + gap);
    doc.roundedRect(x, top, w, h, 4).fill(COLORS.panel);
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(t.label.toUpperCase(), x + 8, top + 8, { width: w - 16 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(t.color || COLORS.text).text(String(t.value), x + 8, top + 22, { width: w - 16 });
  });
  doc.x = left;
  doc.y = top + h + 6;
}

// Simple table: columns = [{ header, width, key }]
function table(doc, columns, rows) {
  const left = doc.page.margins.left;
  const rowH = 16;
  const drawHeader = () => {
    let x = left;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted);
    columns.forEach(c => { doc.text(c.header, x + 4, doc.y, { width: c.width - 8, lineBreak: false }); x += c.width; });
    doc.y += rowH - 4;
  };
  ensureSpace(doc, rowH * 2);
  drawHeader();
  rows.forEach((row, i) => {
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    if (i % 2 === 0) doc.rect(left, y - 3, columns.reduce((n, c) => n + c.width, 0), rowH).fill(COLORS.panel);
    let x = left;
    columns.forEach(c => {
      const cell = typeof c.key === 'function' ? c.key(row) : row[c.key];
      doc.font('Helvetica').fontSize(8.5).fillColor(c.color ? c.color(row) : COLORS.text)
        .text(String(cell ?? '-'), x + 4, y, { width: c.width - 8, lineBreak: false, ellipsis: true });
      x += c.width;
    });
    doc.y = y + rowH;
  });
  doc.x = left;
}

// Line chart of the (down-sampled) series with anomalies marked
function lineChart(doc, sensor) {
  const series = sensor.series;
  if (!series || series.length < 2) return;
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const height = 130;
  const padL = 44, padB = 18, padT = 8;
  ensureSpace(doc, height + 16);
  const top = doc.y;

  const t0 = series[0].t, t1 = series[series.length - 1].t;
  let vMin = Infinity, vMax = -Infinity;
  series.forEach(p => { if (p.v < vMin) vMin = p.v; if (p.v > vMax) vMax = p.v; });
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const pad = (vMax - vMin) * 0.08; vMin -= pad; vMax += pad;

  const plotW = width - padL, plotH = height - padB - padT;
  const X = t => left + padL + ((t - t0) / (t1 - t0 || 1)) * plotW;
  const Y = v => top + padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // grid + y labels
  doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
  for (let i = 0; i <= 4; i++) {
    const v = vMin + ((vMax - vMin) * i) / 4;
    const y = Y(v);
    doc.moveTo(left + padL, y).lineTo(left + width, y).lineWidth(0.3).strokeColor(COLORS.line).stroke();
    doc.text(Number(v.toPrecision(4)).toString(), left, y - 3, { width: padL - 6, align: 'right', lineBreak: false });
  }
  // x labels
  doc.text(fmtTime(new Date(t0).toISOString()), left + padL, top + height - padB + 5, { lineBreak: false });
  doc.text(fmtTime(new Date(t1).toISOString()), left + padL, top + height - padB + 5, { width: plotW, align: 'right', lineBreak: false });

  // line
  doc.moveTo(X(series[0].t), Y(series[0].v));
  series.slice(1).forEach(p => doc.lineTo(X(p.t), Y(p.v)));
  doc.lineWidth(1.2).strokeColor(COLORS.accent).stroke();

  // anomaly markers (only for value-based anomalies, not meter interval anomalies)
  sensor.anomalies.filter(a => !a.basis).forEach(a => {
    const t = Date.parse(a.timestamp);
    doc.circle(X(t), Y(a.value), 2.5).fill(a.direction === 'high' ? COLORS.high : COLORS.low);
  });

  doc.x = left;
  doc.y = top + height + 6;
}

function sensorSection(doc, s) {
  sectionTitle(doc, `Sensor: ${s.sensorId}${s.unit ? `  (${s.unit})` : ''}`);
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(`${fmtTime(s.period.start)}  to  ${fmtTime(s.period.end)}   |   ${s.stats.count} readings   |   typical interval ${fmt(s.dataQuality.typicalIntervalSec, 's')}`);
  doc.moveDown(0.5);

  const tiles = [
    { label: 'Average', value: fmt(s.stats.average, s.unit) },
    { label: 'Minimum', value: fmt(s.stats.minimum, s.unit) },
    { label: 'Maximum', value: fmt(s.stats.maximum, s.unit) },
    { label: 'Std dev', value: fmt(s.stats.stdDev) },
    { label: 'Anomalies', value: s.anomalyCount, color: s.anomalyCount ? COLORS.high : COLORS.ok },
    { label: 'Coverage', value: `${s.dataQuality.coveragePct}%`, color: s.dataQuality.coveragePct < 95 ? COLORS.low : COLORS.ok }
  ];
  kpiTiles(doc, tiles);

  if (s.energy) {
    const e = s.energy;
    const energyTiles = e.type === 'power'
      ? [
          { label: 'Energy used', value: `${e.energyKwh} kWh`, color: COLORS.accent },
          { label: 'Average load', value: fmt(e.averageKw, 'kW') },
          { label: 'Peak demand', value: fmt(e.peakDemandKw, 'kW') }
        ]
      : [
          { label: 'Energy consumed', value: `${e.energyKwh} kWh`, color: COLORS.accent },
          { label: 'Peak interval', value: fmt(e.peakIntervalKwh, 'kWh') },
          { label: 'Meter resets', value: e.meterResets, color: e.meterResets ? COLORS.low : COLORS.text }
        ];
    kpiTiles(doc, energyTiles);
    const peakAt = e.peakDemandAt || e.peakIntervalAt;
    if (peakAt) doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(`Peak occurred at ${fmtTime(peakAt)}`);
    doc.moveDown(0.3);
  }

  lineChart(doc, s);

  if (s.anomalies.length) {
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text)
      .text(`Anomalies${s.anomalies[0].basis ? ' (based on interval consumption)' : ''}`);
    doc.moveDown(0.3);
    const shown = s.anomalies.slice(0, MAX_ANOMALY_ROWS);
    table(doc, [
      { header: '#', width: 24, key: r => shown.indexOf(r) + 1 },
      { header: 'Timestamp', width: 140, key: r => fmtTime(r.timestamp) },
      { header: 'Value', width: 85, key: r => fmt(r.value, s.unit) },
      { header: 'Direction', width: 60, key: 'direction', color: r => (r.direction === 'high' ? COLORS.high : COLORS.low) },
      { header: 'Deviation from median', width: 130, key: r => `${r.deviation > 0 ? '+' : ''}${r.deviation}` },
      { header: 'Score', width: 50, key: 'score' }
    ], shown);
    if (s.anomalyCount > shown.length) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted)
        .text(`Showing ${shown.length} of ${s.anomalyCount} anomalies (most severe kept). Full list available via the JSON API.`);
    }
  }

  if (s.dataQuality.gaps.length) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('Data gaps');
    doc.moveDown(0.3);
    table(doc, [
      { header: 'From', width: 150, key: r => fmtTime(r.from) },
      { header: 'To', width: 150, key: r => fmtTime(r.to) },
      { header: 'Duration', width: 90, key: r => formatDuration(r.durationSec) },
      { header: 'Missed readings', width: 100, key: 'missedReadings' }
    ], s.dataQuality.gaps.slice(0, MAX_GAP_ROWS));
  }
}

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86400).toFixed(1)} days`;
}

/**
 * Streams a PDF report to any writable stream (e.g. an Express response or fs.createWriteStream).
 * @param {Object} processedData  output of processSensorData()
 * @param {import('stream').Writable} out
 * @param {Object} [meta]  { title, subtitle }
 */
function generatePDFReport(processedData, out, meta = {}) {
  const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true, info: { Title: meta.title || 'Smart Sensor Report' } });
  doc.pipe(out);

  const { summary, insights, sensors } = processedData;

  // Header
  doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.text).text(meta.title || 'Smart Sensor Performance Report');
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(`${meta.subtitle ? `${meta.subtitle}   |   ` : ''}Period: ${fmtTime(summary.period.start)} to ${fmtTime(summary.period.end)}`)
    .text(`Generated: ${fmtTime(processedData.processedAt)}`);
  doc.moveDown(0.8);

  // Executive summary
  const tiles = [
    { label: 'Sensors', value: summary.sensorCount },
    { label: 'Valid readings', value: summary.validReadings },
    { label: 'Rejected', value: summary.rejectedReadings, color: summary.rejectedReadings ? COLORS.low : COLORS.ok },
    { label: 'Anomalies', value: summary.anomalyCount, color: summary.anomalyCount ? COLORS.high : COLORS.ok },
    { label: 'Data gaps', value: summary.gapCount, color: summary.gapCount ? COLORS.low : COLORS.ok }
  ];
  if (summary.totalEnergyKwh !== null) tiles.push({ label: 'Total energy', value: `${summary.totalEnergyKwh} kWh`, color: COLORS.accent });
  sectionTitle(doc, 'Executive Summary');
  kpiTiles(doc, tiles);

  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.text).text('Key findings');
  doc.moveDown(0.2);
  insights.forEach(line => {
    ensureSpace(doc, 14);
    doc.font('Helvetica').fontSize(9.5).fillColor(COLORS.text).text(`•  ${line}`, { indent: 4 });
  });

  // Sensor overview table (useful when there are many sensors)
  if (sensors.length > 1) {
    sectionTitle(doc, 'Sensor Overview');
    table(doc, [
      { header: 'Sensor', width: 110, key: 'sensorId' },
      { header: 'Unit', width: 45, key: 'unit' },
      { header: 'Readings', width: 60, key: r => r.stats.count },
      { header: 'Average', width: 65, key: r => r.stats.average },
      { header: 'Min', width: 55, key: r => r.stats.minimum },
      { header: 'Max', width: 55, key: r => r.stats.maximum },
      { header: 'Anomalies', width: 60, key: 'anomalyCount', color: r => (r.anomalyCount ? COLORS.high : COLORS.text) },
      { header: 'Coverage', width: 45, key: r => `${r.dataQuality.coveragePct}%` }
    ], sensors);
  }

  // Per-sensor detail, each starting on a fresh page
  sensors.forEach(s => {
    doc.addPage();
    sensorSection(doc, s);
  });

  // Data quality appendix
  if (processedData.rejected && processedData.rejected.length) {
    sectionTitle(doc, 'Appendix: Rejected Rows');
    const byReason = {};
    processedData.rejected.forEach(r => { byReason[r.reason] = (byReason[r.reason] || 0) + 1; });
    table(doc, [
      { header: 'Reason', width: 380, key: 'reason' },
      { header: 'Rows', width: 80, key: 'count' }
    ], Object.entries(byReason).map(([reason, count]) => ({ reason, count })));
    if (summary.rejectedReadings > processedData.rejected.length) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted)
        .text(`Breakdown based on the first ${processedData.rejected.length} of ${summary.rejectedReadings} rejected rows.`);
    }
  }

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // allow writing in the footer area
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted)
      .text(`Page ${i + 1} of ${range.count}`, doc.page.margins.left, doc.page.height - 30,
        { width: doc.page.width - doc.page.margins.left - doc.page.margins.right, align: 'center', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return doc;
}

module.exports = { generatePDFReport };
