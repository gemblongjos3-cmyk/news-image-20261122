// news-image-20261122 — validate the bundled front page and publish it to /output/entry.png
// Node 22, standard library only. Run with: node main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type ImageInfo = { format: string; width: number; height: number };

const MIN_BYTES = 100;
const MAX_BYTES = 1048576; // 1 MiB
const MAX_DIM = 1024;

/** Report a validation failure on stderr and stop the program. */
function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/* ---------------------------------------------------------------- PNG ---- */

// CRC32 table, built once on first use (standard IEEE 802.3 polynomial).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32 over bytes[start, end) as used by PNG chunks. */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function validatePng(b: Uint8Array): ImageInfo {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (b[i] !== PNG_SIGNATURE[i]) throw new Error('bad PNG signature');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let sawIhdr = false;
  let sawIend = false;

  while (offset < b.length) {
    if (offset + 8 > b.length) throw new Error('truncated PNG chunk header');
    const length = readU32(b, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > b.length) throw new Error('truncated PNG chunk body');
    if (sawIend) throw new Error('data after IEND chunk');

    const type = String.fromCharCode(b[typeStart], b[typeStart + 1], b[typeStart + 2], b[typeStart + 3]);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error(`invalid PNG chunk type at offset ${offset}`);
    const expected = readU32(b, dataEnd);
    if (crc32(b, typeStart, dataEnd) !== expected) throw new Error(`CRC32 mismatch in ${type} chunk`);

    if (!sawIhdr) {
      if (type !== 'IHDR') throw new Error('first PNG chunk is not IHDR');
      if (length !== 13) throw new Error('IHDR chunk has wrong length');
      sawIhdr = true;
      width = readU32(b, dataStart);
      height = readU32(b, dataStart + 4);
    }

    if (type === 'IEND') {
      if (length !== 0) throw new Error('IEND chunk is not empty');
      if (crcEnd !== b.length) throw new Error('data after IEND chunk');
      sawIend = true;
    }
    offset = crcEnd;
  }

  if (!sawIhdr) throw new Error('missing IHDR chunk');
  if (!sawIend) throw new Error('missing IEND chunk');
  return { format: 'PNG', width, height };
}

/** Big-endian 32-bit unsigned integer. */
function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
}

/* --------------------------------------------------------------- JPEG ---- */

function validateJpeg(b: Uint8Array): ImageInfo {
  const n = b.length;
  // The file must end exactly with EOI, with no trailing bytes and no truncation.
  if (!(b[n - 2] === 0xff && b[n - 1] === 0xd9)) throw new Error('JPEG does not end with EOI marker (FF D9)');

  let i = 2; // past SOI
  let width = 0;
  let height = 0;
  let sawSof = false;

  while (i < n) {
    if (b[i] !== 0xff) throw new Error(`expected marker at offset ${i}`);
    while (i < n && b[i] === 0xff) i++; // skip fill bytes
    if (i >= n) throw new Error('truncated JPEG: marker expected before EOI');
    const marker = b[i++];

    if (marker === 0x00) throw new Error('unexpected stuffed byte outside entropy data');
    if (marker === 0xd9) {
      if (i !== n) throw new Error('data after EOI marker');
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    if (marker === 0xd8) throw new Error('unexpected nested SOI marker');

    if (i + 2 > n) throw new Error('truncated JPEG segment length');
    const length = (b[i] << 8) | b[i + 1];
    if (length < 2) throw new Error(`invalid JPEG segment length ${length}`);
    const segmentEnd = i + length;
    if (segmentEnd > n) throw new Error('truncated JPEG segment');

    // Baseline, extended-sequential and progressive frames are the accepted ones.
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (length < 8) throw new Error('SOF segment too short');
      sawSof = true;
      height = (b[i + 3] << 8) | b[i + 4];
      width = (b[i + 5] << 8) | b[i + 6];
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error(`unsupported JPEG frame type (marker 0xFF${marker.toString(16).toUpperCase()})`);
    }

    if (marker === 0xda) {
      // Entropy-coded data follows SOS: walk it until the next real marker,
      // honouring byte stuffing (FF 00) and restart markers (FF D0-D7).
      i = segmentEnd;
      let found = false;
      while (i < n) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        let j = i + 1;
        while (j < n && b[j] === 0xff) j++;
        if (j >= n) throw new Error('truncated JPEG entropy data');
        const next = b[j];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
          i = j + 1; // stuffed byte or restart marker: still entropy data
          continue;
        }
        i = j - 1; // real marker; let the outer loop consume it
        found = true;
        break;
      }
      if (!found && i < n) throw new Error('unterminated JPEG scan data');
      continue;
    }

    i = segmentEnd;
  }

  if (!sawSof) throw new Error('JPEG has no SOF0/SOF1/SOF2 frame header');
  return { format: 'JPEG', width, height };
}

/* --------------------------------------------------------------- main ---- */

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, 'entry.png');

  let bytes: Buffer;
  try {
    bytes = readFileSync(source);
  } catch {
    fail(`cannot read ${source} (the bundled entry.png must sit beside main.ts)`);
  }

  if (bytes.length < MIN_BYTES) fail(`image is too small: ${bytes.length} bytes (minimum ${MIN_BYTES})`);
  if (bytes.length > MAX_BYTES) fail(`image is too large: ${bytes.length} bytes (maximum ${MAX_BYTES})`);

  // Detect the real format from magic bytes; the .png name is not trusted.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = PNG_SIGNATURE.every((v, i) => bytes[i] === v);
  if (!isJpeg && !isPng) fail('unrecognised image format (expected JPEG or PNG magic bytes)');

  let info: ImageInfo;
  try {
    info = isJpeg ? validateJpeg(bytes) : validatePng(bytes);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (info.width < 1 || info.height < 1) fail('image has a zero dimension');
  if (info.width > MAX_DIM || info.height > MAX_DIM) {
    fail(`image is ${info.width}x${info.height}; both sides must be at most ${MAX_DIM}px`);
  }

  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  const target = join(outDir, 'entry.png');
  writeFileSync(target, bytes);
  process.stdout.write(`wrote ${target} (${bytes.length} bytes, ${info.format} ${info.width}x${info.height})\n`);
}

main();
