'use strict';
/* Browser pnggen: the SAME pixel-drawing Canvas as engine/pnggen.js (so render.js runs UNCHANGED), but png()
   encodes via an offscreen <canvas>.toDataURL instead of the server's zlib PNG encoder (no zlib in the browser).
   In Node (the test harness) png() returns the raw RGBA buffer so frames can be asserted without a DOM.
   The drawing methods are copied verbatim from pnggen.js; only px (Uint8Array, not Buffer) and png()/pixels() differ. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTVPnggen = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  var FONT = {
    '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111']
  };
  function Canvas(w, h, bg) { this.w = w; this.h = h; this.px = new Uint8Array(w * h * 4); if (bg) this.fillRect(0, 0, w, h, bg); }
  Canvas.prototype.set = function (x, y, c) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; var i = (y * this.w + x) * 4; this.px[i] = c[0]; this.px[i + 1] = c[1]; this.px[i + 2] = c[2]; this.px[i + 3] = c.length > 3 ? c[3] : 255; };
  Canvas.prototype.blend = function (x, y, c, a) { x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return; var i = (y * this.w + x) * 4, ia = 1 - a; this.px[i] = this.px[i] * ia + c[0] * a; this.px[i + 1] = this.px[i + 1] * ia + c[1] * a; this.px[i + 2] = this.px[i + 2] * ia + c[2] * a; this.px[i + 3] = 255; };
  Canvas.prototype.blendRect = function (x, y, w, h, c, a) { for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) this.blend(xx, yy, c, a); };
  Canvas.prototype.vgrad = function (x, y, w, h, top, bot) { for (var yy = 0; yy < h; yy++) { var f = h > 1 ? yy / (h - 1) : 0, col = [top[0] + (bot[0] - top[0]) * f, top[1] + (bot[1] - top[1]) * f, top[2] + (bot[2] - top[2]) * f]; this.fillRect(x, y + yy, w, 1, col); } };
  Canvas.prototype.soft = function (cx, cy, r, c, a) { for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) { var d = Math.sqrt(xx * xx + yy * yy); if (d > r) continue; this.blend(cx + xx, cy + yy, c, a * (1 - d / r)); } };
  Canvas.prototype.fillRect = function (x, y, w, h, c) { for (var yy = y; yy < y + h; yy++) for (var xx = x; xx < x + w; xx++) this.set(xx, yy, c); };
  Canvas.prototype.circle = function (cx, cy, r, c) { for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r) this.set(cx + xx, cy + yy, c); };
  Canvas.prototype.ring = function (cx, cy, r, thick, c) { var r0 = r - thick; for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) { var d = xx * xx + yy * yy; if (d <= r * r && d >= r0 * r0) this.set(cx + xx, cy + yy, c); } };
  Canvas.prototype.arcBand = function (cx, cy, r, thick, a0, a1, c) { var r0 = r - thick; for (var yy = -r; yy <= r; yy++) for (var xx = -r; xx <= r; xx++) { var d = xx * xx + yy * yy; if (d > r * r || d < r0 * r0) continue; var a = Math.atan2(yy, xx); if (a < 0) a += Math.PI * 2; var lo = ((a0 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), hi = ((a1 % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); var inRange = lo <= hi ? (a >= lo && a <= hi) : (a >= lo || a <= hi); if (inRange) this.set(cx + xx, cy + yy, c); } };
  Canvas.prototype.triangle = function (cx, cy, r, c) { for (var yy = -r; yy <= r; yy++) { var width = Math.round((yy + r) / (2 * r) * r); for (var xx = -width; xx <= width; xx++) this.set(cx + xx, cy + yy, c); } };
  Canvas.prototype.digit = function (d, x, y, scale, c) { var gm = FONT[d]; if (!gm) return; var on = [], rx, ry; for (ry = 0; ry < 5; ry++) for (rx = 0; rx < 3; rx++) if (gm[ry][rx] === '1') on.push([rx, ry]);
    on.forEach(function (p) { this.blendRect(x + p[0] * scale - 2, y + p[1] * scale - 2, scale + 4, scale + 4, c, 0.09); }, this);
    on.forEach(function (p) { this.blendRect(x + p[0] * scale + 2, y + p[1] * scale + 3, scale, scale, [0, 0, 0], 0.5); }, this);
    var top = [Math.min(255, c[0] + 70), Math.min(255, c[1] + 70), Math.min(255, c[2] + 55)];
    on.forEach(function (p) { this.vgrad(x + p[0] * scale, y + p[1] * scale, scale, scale, top, c); }, this); };
  Canvas.prototype.number = function (n, x, y, scale, c) { var s = String(n), cx = x; for (var k = 0; k < s.length; k++) { this.digit(s[k], cx, y, scale, c); cx += 4 * scale; } return cx; };
  Canvas.prototype.pixels = function () { return this.px; };
  Canvas.prototype.png = function () {
    if (typeof document !== 'undefined' && document.createElement) {
      var cv = document.createElement('canvas'); cv.width = this.w; cv.height = this.h;
      var ctx = cv.getContext('2d'); var id = ctx.createImageData(this.w, this.h);
      id.data.set(this.px); ctx.putImageData(id, 0, 0);
      return cv.toDataURL('image/png');
    }
    return this.px;   // Node (harness): raw RGBA, so a frame can be asserted with no DOM
  };
  function greenL(L) { var l = L, s = 0.55, h = 45 / 360; var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    var hue2 = function (t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
    return [Math.round(hue2(h + 1 / 3) * 255), Math.round(hue2(h) * 255), Math.round(hue2(h - 1 / 3) * 255)]; }
  return { Canvas: Canvas, greenL: greenL, encodePNG: function () { return null; } };
}));
