import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function newContext() {
  return {
    kind: 'user' as const,
    key: Math.random().toString(36).substring(2, 15),
  };
}

export function writeOutput(data: unknown): void {
  const dir = join(__dirname, '..', 'output');
  mkdirSync(dir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, checksum]);
}

/**
 * Encodes a solid-colour PNG as base64 so multimodal examples can ship without a
 * binary fixture. The colour is the only thing the model can report back, which
 * makes it a usable signal for whether the image actually reached the provider.
 */
export function solidColorPngBase64([r, g, b]: [number, number, number], size = 64): string {
  const bytesPerRow = size * 3 + 1;
  const raw = Buffer.alloc(size * bytesPerRow);
  for (let y = 0; y < size; y++) {
    const rowStart = y * bytesPerRow;
    for (let x = 0; x < size; x++) {
      const pixel = rowStart + 1 + x * 3;
      raw[pixel] = r;
      raw[pixel + 1] = g;
      raw[pixel + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
