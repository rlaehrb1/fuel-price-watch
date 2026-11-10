// 아이콘 PNG를 만든다: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(root, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

// 0~1 좌표에서 그림 안쪽이면 색을, 아니면 null을 돌려준다.
function paint(u, v) {
  const inRound = (x, y, r) => {
    const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    return Math.hypot(dx, dy) <= r;
  };
  if (!inRound(u, v, 0.22)) return null;
  // 물방울: 아래 원 + 위로 좁아지는 꼭지
  const cx = 0.5;
  const cy = 0.6;
  const r = 0.21;
  const inCircle = Math.hypot(u - cx, v - cy) <= r;
  const top = 0.17;
  const t = (v - top) / (cy - top);
  const inTip = v >= top && v <= cy && Math.abs(u - cx) <= r * Math.pow(Math.max(t, 0), 1.35);
  if (inCircle || inTip) return [255, 255, 255, 255];
  return [11, 107, 203, 255];
}

function png(size) {
  const samples = 4;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x += 1) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const color = paint((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          if (!color) continue;
          sum[0] += color[0];
          sum[1] += color[1];
          sum[2] += color[2];
          sum[3] += 1;
        }
      }
      const offset = row + 1 + x * 4;
      const hits = sum[3] || 1;
      raw[offset] = Math.round(sum[0] / hits);
      raw[offset + 1] = Math.round(sum[1] / hits);
      raw[offset + 2] = Math.round(sum[2] / hits);
      raw[offset + 3] = Math.round((sum[3] / (samples * samples)) * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(root, `icon${size}.png`), png(size));
}
console.log('icons written');
