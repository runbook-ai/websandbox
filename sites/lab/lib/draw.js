'use strict';
// Small raster toolkit for the lab's text images (receipt photos, report charts): an RGB canvas,
// filled rectangles, a 5x7 bitmap font drawn at an integer scale, light paper noise, and PNG
// encode/decode. Text lands on a fixed grid, so readText() can read an image back exactly (the UI
// checker uses it to confirm the pixels carry the answer).
const zlib = require('zlib');

// 5x7 glyphs, one string of 5 chars per row ('#' = ink)
const G = {
  'A': ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'], 'B': ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  'C': ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'], 'D': ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  'E': ['#####', '#....', '#....', '####.', '#....', '#....', '#####'], 'F': ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  'G': ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'], 'H': ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  'I': ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'], 'J': ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  'K': ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'], 'L': ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  'M': ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'], 'N': ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  'O': ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], 'P': ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  'Q': ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'], 'R': ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  'S': ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'], 'T': ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  'U': ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'], 'V': ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  'W': ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'], 'X': ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  'Y': ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'], 'Z': ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'], '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'], '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'], '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'], '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'], '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'], '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'], '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'], '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'], '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'], '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
};
const CHARS = Object.keys(G);

function canvas(w, h, bg = [255, 255, 255]) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
  return { w, h, px };
}
function rect(c, x0, y0, w, h, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(c.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(c.w, x0 + w); x++) { const i = (y * c.w + x) * 3; c.px[i] = rgb[0]; c.px[i + 1] = rgb[1]; c.px[i + 2] = rgb[2]; }
  }
}
// text at (x, y), cell = 6 x 9 font units (5x7 glyph + spacing), scale s; unknown chars draw as space
function text(c, x, y, str, s, rgb) {
  let cx = x;
  for (const ch of String(str).toUpperCase()) {
    const g = G[ch] || G[' '];
    for (let r = 0; r < 7; r++) for (let k = 0; k < 5; k++) if (g[r][k] === '#') rect(c, cx + k * s, y + r * s, s, s, rgb);
    cx += 6 * s;
  }
  return cx;
}
const textWidth = (str, s) => String(str).length * 6 * s;
// warm paper tint, shaded a little from top to bottom (smooth, so the PNG stays small); ink untouched
function paper(c, seed, tint = [250, 248, 240]) {
  const shade = (seed >>> 0) % 7;
  for (let y = 0; y < c.h; y++) {
    const v = Math.round(-shade * y / c.h);
    for (let x = 0; x < c.w; x++) {
      const i = (y * c.w + x) * 3;
      if (c.px[i] < 200) continue;
      c.px[i] = tint[0] + v; c.px[i + 1] = tint[1] + v; c.px[i + 2] = tint[2] + v;
    }
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) c.px.copy(raw, y * (c.w * 3 + 1) + 1, y * c.w * 3, (y + 1) * c.w * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0); ihdr.writeUInt32BE(c.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function decode(buf) {
  let off = 8, w = 0, h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 3, y * (w * 3 + 1) + 1, (y + 1) * (w * 3 + 1));
  return { w, h, px };
}
// read one line of text of n cells at (x, y), scale s: each cell's ink pattern vs the glyphs
function readText(img, x, y, n, s, isInk = (r, g, b) => r + g + b < 300) {
  let out = '';
  for (let k = 0; k < n; k++) {
    let best = ' ', bestD = Infinity;
    for (const ch of CHARS) {
      let d = 0;
      for (let r = 0; r < 7 && d < bestD; r++) {
        for (let q = 0; q < 5; q++) {
          const px = x + k * 6 * s + q * s + (s >> 1), py = y + r * s + (s >> 1);
          const i = (py * img.w + px) * 3;
          const ink = isInk(img.px[i], img.px[i + 1], img.px[i + 2]);
          if (ink !== (G[ch][r][q] === '#')) d++;
        }
      }
      if (d < bestD) { bestD = d; best = ch; }
    }
    out += best;
  }
  return out;
}

module.exports = { canvas, rect, text, textWidth, paper, png, decode, readText, GLYPHS: G };
