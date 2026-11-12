#!/usr/bin/env node
// Draws the wallet's PNG icons, for the places that take no SVG: the home
// screens of Android and iPhone, and installs on the desktop. They are
// web/icon.svg's shapes, so a change to one is a change to both.
//
//   node scripts/icons.mjs        → web/icons/*.png
//
// icon.svg is 64 × 64: a navy tile with rounded corners, a lavender ring and
// a white T. The tile icons keep its corners. The maskable icon and the
// iPhone's fill the square, since Android and iOS cut their own shape out of
// it; the maskable one draws the ring and T smaller, inside the circle every
// Android shape keeps.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const NAVY = [0x0b, 0x12, 0x20];
const LAVENDER = [0xa5, 0xa6, 0xff];
const WHITE = [0xff, 0xff, 0xff];

// icon.svg's shapes, in its units.
const CORNER = 14;
const RING = 17;
const STROKE = 4;
const T = [
  [24, 26, 40, 26],
  [32, 26, 32, 42],
];

const ICONS = [
  { file: 'icon-192.png', size: 192, corner: CORNER, scale: 1 },
  { file: 'icon-512.png', size: 512, corner: CORNER, scale: 1 },
  { file: 'maskable-512.png', size: 512, corner: 0, scale: 0.8 },
  { file: 'apple-touch-icon.png', size: 180, corner: 0, scale: 1 },
];

/** Samples per pixel, per side: the edges are smoothed over 8 × 8 of them. */
const SAMPLES = 8;

function onTile(x, y, corner) {
  const dx = Math.max(corner - x, 0, x - (64 - corner));
  const dy = Math.max(corner - y, 0, y - (64 - corner));
  return dx * dx + dy * dy <= corner * corner;
}

function onStroke(x, y, [ax, ay, bx, by]) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
  const dx = x - (ax + t * vx);
  const dy = y - (ay + t * vy);
  return dx * dx + dy * dy <= (STROKE / 2) ** 2;
}

/** The colour at a point of the 64 × 64 square, or null off the tile. */
function colour(x, y, { corner, scale }) {
  if (!onTile(x, y, corner)) return null;
  const gx = 32 + (x - 32) / scale;
  const gy = 32 + (y - 32) / scale;
  if (T.some((stroke) => onStroke(gx, gy, stroke))) return WHITE;
  if (Math.abs(Math.sqrt((gx - 32) ** 2 + (gy - 32) ** 2) - RING) <= STROKE / 2) return LAVENDER;
  return NAVY;
}

/** Rows of pixels, each after its PNG filter byte (none): RGB when opaque, else RGBA. */
function draw(icon) {
  const { size } = icon;
  const opaque = icon.corner === 0;
  const channels = opaque ? 3 : 4;
  const rows = Buffer.alloc(size * (1 + size * channels));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = colour(((px + (sx + 0.5) / SAMPLES) * 64) / size, ((py + (sy + 0.5) / SAMPLES) * 64) / size, icon);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      const at = py * (1 + size * channels) + 1 + px * channels;
      if (!n) continue;
      rows[at] = Math.round(r / n);
      rows[at + 1] = Math.round(g / n);
      rows[at + 2] = Math.round(b / n);
      if (!opaque) rows[at + 3] = Math.round((255 * n) / SAMPLES ** 2);
    }
  }
  return { rows, opaque };
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, { rows, opaque }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = opaque ? 2 : 6; // RGB, or RGB with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../web/icons/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const icon of ICONS) {
  writeFileSync(new URL(icon.file, out), png(icon.size, draw(icon)));
  console.log(`web/icons/${icon.file}`);
}
