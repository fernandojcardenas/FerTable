// Draws the app icons (a 3×3 grid on the accent color) as PNGs, with no dependencies.
// Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const ACCENT = [59, 91, 219], WHITE = [255, 255, 255];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}

/** maskable: full-bleed background with the glyph inside the safe zone; otherwise a rounded tile. */
function icon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const r = maskable ? 0 : size * 0.22;
  const inset = maskable ? size * 0.28 : size * 0.22;
  const cell = (size - inset * 2) / 3, gap = cell * 0.16;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    // Rounded-square mask (with 1px soft edge).
    const dx = Math.max(r - x, x - (size - 1 - r), 0), dy = Math.max(r - y, y - (size - 1 - r), 0);
    const d = Math.hypot(dx, dy);
    const alpha = r === 0 ? 1 : Math.max(0, Math.min(1, r - d + 0.5));
    let color = ACCENT;
    const gx = (x - inset) / cell, gy = (y - inset) / cell;
    if (gx >= 0 && gy >= 0 && gx < 3 && gy < 3) {
      const fx = (x - inset) - Math.floor(gx) * cell, fy = (y - inset) - Math.floor(gy) * cell;
      if (fx > gap / 2 && fx < cell - gap / 2 && fy > gap / 2 && fy < cell - gap / 2) {
        // The top row is the header: solid white; the rest is lighter.
        color = Math.floor(gy) === 0 ? WHITE : [200, 212, 255];
      }
    }
    px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = Math.round(alpha * 255);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = new URL("../public/icons/", import.meta.url);
writeFileSync(new URL("icon-192.png", out), icon(192));
writeFileSync(new URL("icon-512.png", out), icon(512));
writeFileSync(new URL("maskable-512.png", out), icon(512, { maskable: true }));
writeFileSync(new URL("apple-touch-icon.png", out), icon(180, { maskable: true }));
console.log("icons written");
