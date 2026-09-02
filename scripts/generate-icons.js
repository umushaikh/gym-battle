// One-off generator for the PWA home-screen icons (public/icons/icon-*.png).
// Draws a simple barbell glyph as raw PNG bytes so the build has no
// external image-asset or canvas-library dependency. Re-run after
// changing the colors below: node scripts/generate-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [15, 23, 42];
const BAR = [241, 245, 249];
const PLATE = [34, 197, 94];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeIconPng(size) {
  const barHeight = Math.round(size * 0.09);
  const barY0 = Math.round(size / 2 - barHeight / 2);
  const barY1 = barY0 + barHeight;
  const barX0 = Math.round(size * 0.12);
  const barX1 = Math.round(size * 0.88);

  const plateWidth = Math.round(size * 0.12);
  const plateHeight = Math.round(size * 0.5);
  const plateY0 = Math.round(size / 2 - plateHeight / 2);
  const plateY1 = plateY0 + plateHeight;
  const leftPlateX0 = Math.round(size * 0.08);
  const leftPlateX1 = leftPlateX0 + plateWidth;
  const rightPlateX1 = Math.round(size * 0.92);
  const rightPlateX0 = rightPlateX1 - plateWidth;

  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      let color = BG;
      const inBar = y >= barY0 && y < barY1 && x >= barX0 && x < barX1;
      const inLeftPlate = x >= leftPlateX0 && x < leftPlateX1 && y >= plateY0 && y < plateY1;
      const inRightPlate = x >= rightPlateX0 && x < rightPlateX1 && y >= plateY0 && y < plateY1;
      if (inLeftPlate || inRightPlate) color = PLATE;
      else if (inBar) color = BAR;
      const idx = rowStart + 1 + x * 4;
      raw[idx] = color[0];
      raw[idx + 1] = color[1];
      raw[idx + 2] = color[2];
      raw[idx + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makeIconPng(size));
  console.log(`wrote icons/icon-${size}.png`);
}
