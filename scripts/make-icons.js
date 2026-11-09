// 產生 App 圖示（純 Node，不需要任何繪圖套件）：漸層底 + 白色愛心
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lerp = (a, b, t) => a + (b - a) * t;
const C1 = hex('#ffb199');
const C2 = hex('#ff6b8b');
const C3 = hex('#e9507a');

// 經典愛心曲線：(x²+y²−1)³ − x²y³ ≤ 0，寬約 2.28、高約 2.24
function inHeart(x, y) {
  const a = x * x + y * y - 1;
  return a * a * a - x * x * y * y * y <= 0;
}

function draw(size, { heartWidth, background }) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 2.28 / (heartWidth * size); // 每像素對應的曲線單位
  const SS = 4; // 4×4 超取樣抗鋸齒
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - size / 2) * scale;
          const y = -(py + (sy + 0.5) / SS - size / 2) * scale + 0.1;
          if (inHeart(x, y)) hits++;
        }
      }
      const cover = hits / (SS * SS);
      const i = (py * size + px) * 4;
      if (background) {
        const t = (px + py) / (2 * size);
        const bg = t < 0.55
          ? C1.map((c, k) => lerp(c, C2[k], t / 0.55))
          : C2.map((c, k) => lerp(c, C3[k], (t - 0.55) / 0.45));
        for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(lerp(bg[k], 255, cover));
        rgba[i + 3] = 255;
      } else {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 255;
        rgba[i + 3] = Math.round(cover * 255);
      }
    }
  }
  return encodePNG(size, rgba);
}

const targets = [
  ['icon-192.png', 192, { heartWidth: 0.56, background: true }],
  ['icon-512.png', 512, { heartWidth: 0.56, background: true }],
  ['icon-maskable-512.png', 512, { heartWidth: 0.44, background: true }], // 留安全區給 Android 遮罩
  ['apple-touch-icon.png', 180, { heartWidth: 0.56, background: true }],
  ['badge-96.png', 96, { heartWidth: 0.86, background: false }], // Android 狀態列單色小圖示
];
for (const [name, size, opts] of targets) {
  fs.writeFileSync(path.join(OUT, name), draw(size, opts));
  console.log('✓', name);
}
