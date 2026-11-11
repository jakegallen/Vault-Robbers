/* Synchronous SHA-256 with a Node-crypto-compatible surface, so the Vault Robbers skill engine
   (skillgames.js / skillv4.js) runs UNCHANGED in the browser and produces byte-identical rng streams
   to the original server. Public domain style implementation. Works in Node and the browser (UMD).

   Exposes a drop-in for `require('crypto')`:
     createHash('sha256').update(str|bytes).digest()  -> Bytes (Uint8Array) with readUInt32BE(off) + toString('hex')
     randomBytes(n)                                    -> Bytes with toString('hex')  (browser: getRandomValues; node: real crypto)
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RTVCrypto = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function toBytes(msg) {
    if (msg instanceof Uint8Array) return msg;
    if (typeof msg === 'string') {
      // UTF-8 encode (matches Node's default 'utf8' for .update(string))
      var out = [], i, c;
      for (i = 0; i < msg.length; i++) {
        c = msg.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
        else { // surrogate pair
          i++; c = 0x10000 + (((c & 0x3ff) << 10) | (msg.charCodeAt(i) & 0x3ff));
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        }
      }
      return new Uint8Array(out);
    }
    if (Array.isArray(msg)) return new Uint8Array(msg);
    return new Uint8Array(0);
  }

  function digestBytes(bytes) {
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l = bytes.length;
    var withOne = l + 1;
    var k = (56 - (withOne % 64) + 64) % 64;
    var total = withOne + k + 8;
    var m = new Uint8Array(total);
    m.set(bytes, 0);
    m[l] = 0x80;
    var bitLenHi = Math.floor((l * 8) / 0x100000000), bitLenLo = (l * 8) >>> 0;
    m[total - 8] = (bitLenHi >>> 24) & 0xff; m[total - 7] = (bitLenHi >>> 16) & 0xff;
    m[total - 6] = (bitLenHi >>> 8) & 0xff; m[total - 5] = bitLenHi & 0xff;
    m[total - 4] = (bitLenLo >>> 24) & 0xff; m[total - 3] = (bitLenLo >>> 16) & 0xff;
    m[total - 2] = (bitLenLo >>> 8) & 0xff; m[total - 1] = bitLenLo & 0xff;

    var w = new Int32Array(64), i, t, a, b, c, d, e, f, g, h, s0, s1, ch, maj, t1, t2;
    for (var off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = (m[off + i*4] << 24) | (m[off + i*4+1] << 16) | (m[off + i*4+2] << 8) | (m[off + i*4+3]);
      for (i = 16; i < 64; i++) {
        var x = w[i-15], y = w[i-2];
        s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      a=H[0];b=H[1];c=H[2];d=H[3];e=H[4];f=H[5];g=H[6];h=H[7];
      for (i = 0; i < 64; i++) {
        s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        ch = (e & f) ^ (~e & g);
        t1 = (h + s1 + ch + K[i] + w[i]) | 0;
        s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        maj = (a & b) ^ (a & c) ^ (b & c);
        t2 = (s0 + maj) | 0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[i*4]=(H[i]>>>24)&0xff; out[i*4+1]=(H[i]>>>16)&0xff; out[i*4+2]=(H[i]>>>8)&0xff; out[i*4+3]=H[i]&0xff; }
    return out;
  }

  var HEX = '0123456789abcdef';
  function wrap(u8) {
    // a Buffer-like view with the two methods the engine calls on a digest
    u8.readUInt32BE = function (off) { off = off | 0; return ((u8[off] << 24) | (u8[off+1] << 16) | (u8[off+2] << 8) | u8[off+3]) >>> 0; };
    var origToString = u8.toString;
    u8.toString = function (enc) {
      if (enc === 'hex') { var s = ''; for (var i = 0; i < u8.length; i++) { s += HEX[u8[i] >> 4] + HEX[u8[i] & 15]; } return s; }
      return origToString ? origToString.call(u8, enc) : Array.prototype.join.call(u8, ',');
    };
    return u8;
  }

  function createHash(algo) {
    if (algo !== 'sha256') throw new Error('RTVCrypto: only sha256 is supported (got ' + algo + ')');
    var parts = [], len = 0;
    return {
      update: function (msg) { var b = toBytes(msg); parts.push(b); len += b.length; return this; },
      digest: function (enc) {
        var all = new Uint8Array(len), o = 0, i;
        for (i = 0; i < parts.length; i++) { all.set(parts[i], o); o += parts[i].length; }
        var d = wrap(digestBytes(all));
        return enc === 'hex' ? d.toString('hex') : d;
      }
    };
  }

  // HMAC-SHA256 with the same Node-crypto-compatible surface (createHmac('sha256', key).update(msg).digest('hex'|undefined)).
  // Needed by the crack odds engine: roll() (provably-fair) and _hb() (seeded door/tier shuffle) call crypto.createHmac.
  function createHmac(algo, key) {
    if (algo !== 'sha256') throw new Error('RTVCrypto: only sha256 hmac is supported (got ' + algo + ')');
    var BS = 64, kb = toBytes(key);
    if (kb.length > BS) kb = digestBytes(kb);
    var k0 = new Uint8Array(BS); k0.set(kb, 0);
    var ipad = new Uint8Array(BS), opad = new Uint8Array(BS), i;
    for (i = 0; i < BS; i++) { ipad[i] = k0[i] ^ 0x36; opad[i] = k0[i] ^ 0x5c; }
    var parts = [ipad], len = BS;
    return {
      update: function (msg) { var b = toBytes(msg); parts.push(b); len += b.length; return this; },
      digest: function (enc) {
        var inner = new Uint8Array(len), o = 0, j;
        for (j = 0; j < parts.length; j++) { inner.set(parts[j], o); o += parts[j].length; }
        var ih = digestBytes(inner);
        var outer = new Uint8Array(BS + 32); outer.set(opad, 0); outer.set(ih, BS);
        var d = wrap(digestBytes(outer));
        return enc === 'hex' ? d.toString('hex') : d;
      }
    };
  }

  function randomBytes(n) {
    var u8 = new Uint8Array(n);
    if (typeof self !== 'undefined' && self.crypto && self.crypto.getRandomValues) self.crypto.getRandomValues(u8);
    else { // node fallback (used only by the test harness)
      try { var nc = require('crypto'); var b = nc.randomBytes(n); for (var i = 0; i < n; i++) u8[i] = b[i]; }
      catch (e) { for (var j = 0; j < n; j++) u8[j] = (Math.random() * 256) | 0; }
    }
    return wrap(u8);
  }

  return { createHash: createHash, createHmac: createHmac, randomBytes: randomBytes };
}));
