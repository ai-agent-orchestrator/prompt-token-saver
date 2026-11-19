import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Code-drawn app icons. No external images, fonts, credentials, or runtime dependency.
const directory = path.resolve(import.meta.dirname, '../public/icons');
await mkdir(directory, { recursive: true });
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, crc]);
}
function png(size) {
  const pixels = Buffer.alloc(size * (1 + size * 4));
  const rectangles = [
    [112, 142, 84, 228, [122, 162, 247]],
    [214, 142, 84, 228, [84, 119, 185]],
    [316, 142, 84, 228, [50, 77, 125]],
    [128, 174, 52, 12, [11, 16, 23]], [128, 205, 52, 12, [11, 16, 23]], [128, 236, 38, 12, [11, 16, 23]],
    [230, 174, 52, 12, [11, 16, 23]], [230, 205, 38, 12, [11, 16, 23]],
    [332, 174, 52, 12, [226, 232, 240]],
  ];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) * 512 / size, py = (y + .5) * 512 / size;
    let color = [11, 16, 23];
    for (const [left, top, width, height, fill] of rectangles) {
      if (px >= left && px < left + width && py >= top && py < top + height) color = fill;
    }
    const offset = y * (1 + size * 4) + 1 + x * 4;
    pixels.set([...color, 255], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await writeFile(path.join(directory, name), png(size));
}
console.log('Prepared 192px, 512px and Apple touch app icons.');
