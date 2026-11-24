'use strict';
// Text images for image tasks: receipt photos (task input files) and the usage-trend bar chart
// (Reports > Trends). Each has a layout function (where every text line goes) shared by the
// renderer and by read-back (draw.readText), so a check can read an image exactly.
const D = require('./draw');

const INK = [34, 34, 38];
const cents = (c) => `$${(c / 100).toFixed(2)}`;

// ---- receipt: {merchant, address, date 'YYYY-MM-DD', time 'HH:MM', items: [[name, cents]], tax, total, card4, seed}
const R = { w: 432, margin: 24, s: 2, head: 3, lineH: 26 };
function receiptLines(r) {
  const cols = Math.floor((R.w - 2 * R.margin) / (6 * R.s));
  const pad = (l, rr) => `${l}${' '.repeat(Math.max(1, cols - l.length - rr.length))}${rr}`;
  const lines = [];
  let y = R.margin;
  const center = (t, s) => { lines.push({ t, x: Math.floor((R.w - D.textWidth(t, s)) / 2), y, s }); y += s === R.head ? 34 : R.lineH; };
  const left = (t) => { lines.push({ t, x: R.margin, y, s: R.s }); y += R.lineH; };
  center(r.merchant.toUpperCase().slice(0, Math.floor((R.w - 2 * R.margin) / (6 * R.head))), R.head);
  center(r.address.toUpperCase(), R.s);
  y += 8;
  left(pad(`DATE ${r.date}`, r.time));
  left('-'.repeat(cols));
  for (const [name, c] of r.items) left(pad(name.toUpperCase().slice(0, cols - 10), cents(c)));
  left('-'.repeat(cols));
  left(pad('TAX', cents(r.tax)));
  left(pad('TOTAL', cents(r.total)));
  y += 8;
  left(`CARD **** ${r.card4}`);
  center('THANK YOU', R.s);
  return { lines, h: y + R.margin };
}
function receipt(r) {
  const L = receiptLines(r);
  const c = D.canvas(R.w, L.h);
  for (const l of L.lines) D.text(c, l.x, l.y, l.t, l.s, INK);
  D.paper(c, r.seed || 1);
  return D.png(c);
}
function readReceipt(png, r) {
  const img = D.decode(png);
  return receiptLines(r).lines.map((l) => D.readText(img, l.x, l.y, l.t.length, l.s).trimEnd());
}

// ---- usage trend chart: {team, metric label, points: [[label 'DEC 24', value]]}
const C = { slot: 84, left: 40, top: 80, plot: 300, s: 2 };
function chartLayout(ch) {
  const w = C.left * 2 + ch.points.length * C.slot, h = C.top + C.plot + 60;
  const max = Math.max(...ch.points.map((p) => p[1]));
  const bars = ch.points.map(([label, v], i) => {
    const bh = Math.max(2, Math.round((v / max) * (C.plot - 30)));
    const x = C.left + i * C.slot + 12, bw = C.slot - 24;
    const vs = String(v);
    return { label, v, x, y: C.top + C.plot - bh, bw, bh,
      vt: { t: vs, x: x + Math.floor((bw - D.textWidth(vs, C.s)) / 2), y: C.top + C.plot - bh - 22, s: C.s },
      lt: { t: label, x: C.left + i * C.slot + Math.floor((C.slot - D.textWidth(label, C.s)) / 2), y: C.top + C.plot + 14, s: C.s } };
  });
  const title = `${ch.team} ${ch.metric} BY MONTH`.toUpperCase();
  return { w, h, bars, title: { t: title, x: C.left, y: 24, s: C.s } };
}
function chart(ch) {
  const L = chartLayout(ch);
  const c = D.canvas(L.w, L.h, [252, 252, 250]);
  D.rect(c, C.left - 2, C.top + C.plot, L.w - 2 * C.left + 4, 2, [120, 120, 130]);
  for (let k = 1; k <= 4; k++) D.rect(c, C.left, C.top + C.plot - Math.round(k * (C.plot - 30) / 4), L.w - 2 * C.left, 1, [228, 228, 234]);
  for (const b of L.bars) {
    D.rect(c, b.x, b.y, b.bw, b.bh, [59, 91, 219]);
    D.text(c, b.vt.x, b.vt.y, b.vt.t, b.vt.s, INK);
    D.text(c, b.lt.x, b.lt.y, b.lt.t, b.lt.s, INK);
  }
  D.text(c, L.title.x, L.title.y, L.title.t, L.title.s, INK);
  return D.png(c);
}
function readChart(png, ch) {
  const img = D.decode(png);
  return chartLayout(ch).bars.map((b) => [D.readText(img, b.lt.x, b.lt.y, b.lt.t.length, b.lt.s), +D.readText(img, b.vt.x, b.vt.y, b.vt.t.length, b.vt.s)]);
}

// read-back from the pixels alone (no layout input): what a checker that only has the image can do
const isInk = (r, g, b) => r + g + b < 300;
function readReceiptBlind(png) {
  const img = D.decode(png);
  // the centred title: its first inked column, scale 3
  let x0 = img.w;
  for (let y = R.margin; y < R.margin + 21; y++) for (let x = 0; x < img.w; x++) { const i = (y * img.w + x) * 3; if (isInk(img.px[i], img.px[i + 1], img.px[i + 2])) { x0 = Math.min(x0, x); break; } }
  const merchant = D.readText(img, x0, R.margin, Math.floor((img.w - x0) / (6 * R.head)), R.head).trim();
  const cols = Math.floor((R.w - 2 * R.margin) / (6 * R.s));
  const lines = [];
  for (let y = R.margin + 34 + R.lineH + 8; y + 14 < img.h; y += R.lineH) {
    const t = D.readText(img, R.margin, y, cols, R.s).trimEnd();
    lines.push(t);
    if (t.startsWith('TOTAL')) break;
  }
  return { merchant, lines };
}
function readChartBlind(png) {
  const img = D.decode(png);
  const n = Math.round((img.w - 2 * C.left) / C.slot);
  const out = [];
  for (let k = 0; k < n; k++) {
    const x = C.left + k * C.slot + 12, bw = C.slot - 24, mid = x + (bw >> 1);
    let top = C.top + C.plot;
    for (let y = C.top - 30; y < C.top + C.plot; y++) { const i = (y * img.w + mid) * 3; if (img.px[i] < 100 && img.px[i + 2] > 180) { top = y; break; } }
    const label = D.readText(img, C.left + k * C.slot + Math.floor((C.slot - D.textWidth('MMM YY', C.s)) / 2), C.top + C.plot + 14, 6, C.s);
    let v = null;
    for (const len of [5, 4, 3, 2, 1]) {
      const t = D.readText(img, x + Math.floor((bw - D.textWidth('0'.repeat(len), C.s)) / 2), top - 22, len, C.s);
      if (/^\d+$/.test(t)) { v = +t; break; }
    }
    out.push([label, v]);
  }
  return out;
}

module.exports = { receipt, receiptLines, readReceipt, chart, chartLayout, readChart, readReceiptBlind, readChartBlind };
