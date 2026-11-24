'use strict';
// Part photos for the spare-parts catalog: a PNG drawn from a part's photo columns (shape, tag
// colour, number of mounting holes, angle) with a seeded background, so what a photo shows is never
// in the page text. render(part) -> PNG Buffer (360x270, drawn at 2x and averaged down).
// analyze(png) reads a photo back (tag colour by pixel count, holes as dark blobs); the UI checker
// uses it to confirm the pixels carry the answer.
const zlib = require('zlib');

const W = 360, H = 270, S = 2;
const COLORS = {
  red: [214, 40, 40], blue: [29, 78, 216], green: [21, 128, 61],
  yellow: [245, 197, 24], orange: [249, 115, 22], purple: [126, 34, 206],
};
const SHAPES = ['plate', 'bracket', 'gear', 'flange'];
const HOLE = [38, 38, 42];

const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function canvas(w, h) { return { w, h, px: new Float32Array(w * h * 3) }; }
function blend(c, i, rgb, a) {
  c.px[i] += (rgb[0] - c.px[i]) * a; c.px[i + 1] += (rgb[1] - c.px[i + 1]) * a; c.px[i + 2] += (rgb[2] - c.px[i + 2]) * a;
}
// even-odd scanline fill of one or more closed polygons; shade(x, y) -> rgb (optional)
function fill(c, polys, rgb, a = 1, shade = null) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of polys) for (const [, y] of p) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(c.h - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs = [];
    for (const p of polys) {
      for (let k = 0; k < p.length; k++) {
        const [ax, ay] = p[k], [bx, by] = p[(k + 1) % p.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(c.w, Math.round(xs[k + 1]));
      for (let x = xa; x < xb; x++) blend(c, (y * c.w + x) * 3, shade ? shade(x, y) : rgb, a);
    }
  }
}
const circle = (cx, cy, r, n = 72) => Array.from({ length: n }, (_, k) => [cx + r * Math.cos((2 * Math.PI * k) / n), cy + r * Math.sin((2 * Math.PI * k) / n)]);
const roundRect = (x0, y0, x1, y1, r) => {
  const pts = [];
  const arc = (cx, cy, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + (Math.PI / 2) * (k / 8); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  arc(x1 - r, y0 + r, -Math.PI / 2); arc(x1 - r, y1 - r, 0); arc(x0 + r, y1 - r, Math.PI / 2); arc(x0 + r, y0 + r, Math.PI);
  return pts;
};
function gear(cx, cy, r, teeth) {
  const pts = [];
  for (let k = 0; k < teeth * 4; k++) {
    const a = (2 * Math.PI * k) / (teeth * 4);
    const rr = k % 4 < 2 ? r : r * 0.86;
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return pts;
}
const rot = (pts, cx, cy, deg) => {
  const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  return pts.map(([x, y]) => [cx + (x - cx) * co - (y - cy) * si, cy + (x - cx) * si + (y - cy) * co]);
};

// the body outline, hole centres and the tag anchor in unrotated coordinates (2x canvas, centre 360,270)
function geometry(shape, holes) {
  const cx = 360, cy = 270;
  let body, centres = [], anchor;
  if (shape === 'plate') {
    body = [roundRect(cx - 200, cy - 105, cx + 200, cy + 105, 26)];
    const step = 340 / Math.max(1, holes - 1);
    centres = Array.from({ length: holes }, (_, k) => [holes === 1 ? cx : cx - 170 + step * k, cy + (k % 2 ? 38 : -38)]);
    anchor = [cx + 200, cy - 105];
  } else if (shape === 'bracket') {
    body = [[[cx - 190, cy - 150], [cx - 80, cy - 150], [cx - 80, cy + 40], [cx + 200, cy + 40], [cx + 200, cy + 150], [cx - 190, cy + 150]]];
    // along the vertical arm first, then the foot
    const spots = [[cx - 135, cy - 105], [cx - 135, cy - 30], [cx - 135, cy + 95], [cx - 20, cy + 95], [cx + 70, cy + 95], [cx + 150, cy + 95]];
    centres = spots.slice(0, holes);
    anchor = [cx - 80, cy - 150];
  } else {
    const r = shape === 'gear' ? 185 : 175;
    body = [shape === 'gear' ? gear(cx, cy, r, 18) : circle(cx, cy, r, 120)];
    const rr = shape === 'gear' ? 105 : 120;
    centres = Array.from({ length: holes }, (_, k) => { const a = -Math.PI / 2 + (2 * Math.PI * k) / holes; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; });
    anchor = [cx + r * 0.7, cy - r * 0.7];
  }
  return { body, centres, anchor, cx, cy };
}

function render(part) {
  const seed = hash(part.photo);
  const c = canvas(W * S, H * S);
  // background: warm grey gradient + fixed noise
  let n = seed;
  for (let y = 0; y < c.h; y++) {
    const t = y / c.h;
    for (let x = 0; x < c.w; x++) {
      n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
      const v = (n >>> 24) / 255 * 6 - 3;
      const i = (y * c.w + x) * 3;
      c.px[i] = 238 - 22 * t + v; c.px[i + 1] = 237 - 22 * t + v; c.px[i + 2] = 232 - 24 * t + v;
    }
  }
  const g = geometry(part.shape, part.holes);
  const R = (pts) => rot(pts, g.cx, g.cy, part.angle);
  const body = g.body.map(R);
  // shadow, body (brushed-metal shade), rim
  fill(c, body.map((p) => p.map(([x, y]) => [x + 14, y + 18])), [60, 60, 60], 0.22);
  if (part.shape === 'flange') fill(c, body, [150, 154, 160]);
  fill(c, body, null, 1, (x, y) => { const v = 150 + 30 * Math.sin((x + y * 0.3) / 37) + (y - g.cy) * -0.04; return [v, v + 3, v + 8]; });
  if (part.shape === 'flange') fill(c, [R(circle(g.cx, g.cy, 70))], [182, 186, 192]);
  for (const [hx, hy] of g.centres.map((p) => R([p])[0])) {
    fill(c, [circle(hx, hy, 24)], [118, 120, 126]);
    fill(c, [circle(hx, hy, 18)], HOLE);
  }
  // the tag: on a short cord from the anchor, upright
  const [ax, ay] = R([g.anchor])[0];
  const tx = Math.min(c.w - 140, Math.max(20, ax + 30)), ty = Math.min(c.h - 100, Math.max(16, ay - 110));
  const cord = [[ax - 3, ay], [ax + 3, ay], [tx + 63, ty + 20], [tx + 57, ty + 20]];
  fill(c, [cord], [90, 80, 70]);
  fill(c, [roundRect(tx + 6, ty + 8, tx + 126, ty + 86, 14)], [40, 40, 40], 0.2);
  const tag = COLORS[part.tag_color];
  fill(c, [roundRect(tx, ty, tx + 120, ty + 78, 14)], tag);
  fill(c, [circle(tx + 60, ty + 20, 9)], [248, 248, 244]);
  return encode(downsample(c));
}

function downsample(c) {
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 3; k++) {
        let s = 0;
        for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) s += c.px[((y * S + dy) * c.w + x * S + dx) * 3 + k];
        out[(y * W + x) * 3 + k] = Math.max(0, Math.min(255, Math.round(s / (S * S))));
      }
    }
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encode(rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// decode one of our own PNGs (RGB, 8 bit, filter 0) and read it back
function decode(png) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 2) throw new Error('not an RGB8 PNG'); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 3 + 1)] !== 0) throw new Error('unsupported PNG filter');
    raw.copy(px, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  }
  return { w, h, px };
}
function analyze(png) {
  const { w, h, px } = decode(png);
  const counts = Object.fromEntries(Object.keys(COLORS).map((k) => [k, 0]));
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = px[i * 3], gg = px[i * 3 + 1], b = px[i * 3 + 2];
    for (const [k, [cr, cg, cb]] of Object.entries(COLORS)) if (Math.abs(r - cr) + Math.abs(gg - cg) + Math.abs(b - cb) < 40) counts[k]++;
    if (r < 70 && gg < 70 && b < 75) dark[i] = 1;
  }
  // dark blobs of hole size
  let holes = 0;
  const seen = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!dark[i] || seen[i]) continue;
    let area = 0;
    const st = [i]; seen[i] = 1;
    while (st.length) {
      const j = st.pop(); area++;
      const x = j % w, y = (j - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const q = yy * w + xx;
        if (dark[q] && !seen[q]) { seen[q] = 1; st.push(q); }
      }
    }
    if (area >= 120 && area <= 600) holes++;
  }
  const tag = Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
  return { tag, holes, counts };
}

module.exports = { render, analyze, COLORS, SHAPES };
