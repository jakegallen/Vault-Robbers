'use strict';
/*
 * Vault Robbers — SECURE TRANSPORT rasterizer (server-side PNG). Part of Skill Engine v4.
 *
 * WHY: under the deterministic model the answer must reach the browser ONLY as pixels a human perceives,
 * never as a JSON field a bot can read. So the server renders each skill challenge's answer-bearing content
 * to a PNG here and serves the image; the client just draws it. A payload/step bot gets an opaque image.
 *
 * Pure Node (zlib only) — no native `canvas` dependency. Minimal 2D API: fillRect, circle, shape, digits.
 */
const zlib = require('zlib');

// ── CRC32 (PNG chunk checksums) ──
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const tb = Buffer.from(type, 'ascii'); const cd = Buffer.concat([tb, data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0); return Buffer.concat([len, cd, crc]); }

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = w * 4; const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 3x5 bitmap digits 0-9 (rows top->bottom, '1'=on)
const FONT = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111']
};

class Canvas {
  constructor(w, h, bg) { this.w = w; this.h = h; this.px = Buffer.alloc(w * h * 4); if (bg) this.fillRect(0, 0, w, h, bg); }
  set(x, y, c) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = (y * this.w + x) * 4; this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = c.length > 3 ? c[3] : 255; }
  // alpha-composite a colour over the existing pixel (a in 0..1) — enables glows, shadows, soft edges
  blend(x, y, c, a) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return; const i = (y * this.w + x) * 4, ia = 1 - a; this.px[i] = this.px[i] * ia + c[0] * a; this.px[i + 1] = this.px[i + 1] * ia + c[1] * a; this.px[i + 2] = this.px[i + 2] * ia + c[2] * a; this.px[i + 3] = 255; }
  blendRect(x, y, w, h, c, a) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.blend(xx, yy, c, a); }
  // vertical-gradient rect (top colour -> bottom colour) — instant metal/liquid shading
  vgrad(x, y, w, h, top, bot) { for (let yy = 0; yy < h; yy++) { const f = h > 1 ? yy / (h - 1) : 0, col = [top[0] + (bot[0] - top[0]) * f, top[1] + (bot[1] - top[1]) * f, top[2] + (bot[2] - top[2]) * f]; this.fillRect(x, y + yy, w, 1, col); } }
  // soft radial glow blended over the scene
  soft(cx, cy, r, c, a) { for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) { const d = Math.sqrt(xx * xx + yy * yy); if (d > r) continue; this.blend(cx + xx, cy + yy, c, a * (1 - d / r)); } }
  fillRect(x, y, w, h, c) { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, c); }
  circle(cx, cy, r, c) { for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r) this.set(cx + xx, cy + yy, c); }
  ring(cx, cy, r, thick, c) { const r0 = r - thick; for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) { const d = xx * xx + yy * yy; if (d <= r * r && d >= r0 * r0) this.set(cx + xx, cy + yy, c); } }
  // draw a filled arc band (for the dial target), angles in radians
  arcBand(cx, cy, r, thick, a0, a1, c) { const r0 = r - thick; for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) { const d = xx * xx + yy * yy; if (d > r * r || d < r0 * r0) continue; let a = Math.atan2(yy, xx); if (a < 0) a += Math.PI * 2; let lo = ((a0 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), hi = ((a1 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); const inRange = lo <= hi ? (a >= lo && a <= hi) : (a >= lo || a <= hi); if (inRange) this.set(cx + xx, cy + yy, c); } }
  triangle(cx, cy, r, c) { for (let yy = -r; yy <= r; yy++) { const width = Math.round((yy + r) / (2 * r) * r); for (let xx = -width; xx <= width; xx++) this.set(cx + xx, cy + yy, c); } }
  digit(d, x, y, scale, c) { const gm = FONT[d]; if (!gm) return; const on = []; for (let ry = 0; ry < 5; ry++) for (let rx = 0; rx < 3; rx++) if (gm[ry][rx] === '1') on.push([rx, ry]);
    for (const [rx, ry] of on) this.blendRect(x + rx * scale - 2, y + ry * scale - 2, scale + 4, scale + 4, c, 0.09);   // glow halo
    for (const [rx, ry] of on) this.blendRect(x + rx * scale + 2, y + ry * scale + 3, scale, scale, [0, 0, 0], 0.5);      // drop shadow
    const top = [Math.min(255, c[0] + 70), Math.min(255, c[1] + 70), Math.min(255, c[2] + 55)];                          // lit top
    for (const [rx, ry] of on) this.vgrad(x + rx * scale, y + ry * scale, scale, scale, top, c);                          // gradient body
  }
  number(n, x, y, scale, c) { const s = String(n); let cx = x; for (const ch of s) { this.digit(ch, cx, y, scale, c); cx += 4 * scale; } return cx; }
  png() { return encodePNG(this.w, this.h, this.px); }
}

// hsl-ish green swatch helper -> rgb (matches the client's 'hsl(150 45% L%)')
function greenL(L) { // V2: repurposed to a GOLD luminance scale (hue 45) so brightness-discrimination tiles match the gold theme (was hsl 150 green)
  const l = L, s = 0.55, h = 45 / 360; const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue2 = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [Math.round(hue2(h + 1 / 3) * 255), Math.round(hue2(h) * 255), Math.round(hue2(h - 1 / 3) * 255)];
}

module.exports = { Canvas, encodePNG, greenL };
