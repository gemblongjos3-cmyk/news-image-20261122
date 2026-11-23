import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(SELF_DIR, "entry.png");

const TARGET_WIDTH = 1024;
const TARGET_HEIGHT = 1024;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const TEM = 0x01;
const SOF0 = 0xc0;
const SOF2 = 0xc2;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

interface Frame {
  width: number;
  height: number;
  marker: number;
}

interface WalkResult {
  frame: Frame | null;
  reachedSos: boolean;
}

// Markers that carry no length field of their own.
function isStandalone(marker: number): boolean {
  return marker === TEM || marker === SOI || marker === EOI || (marker >= 0xd0 && marker <= 0xd7);
}

// Walk the JPEG marker segments after SOI, stopping at SOS.
function walkSegments(bytes: Buffer): WalkResult {
  let offset = 2; // past SOI
  let frame: Frame | null = null;
  let reachedSos = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      fail(`malformed jpeg: expected marker prefix 0xFF at offset ${offset}`);
    }

    // Markers may be preceded by any number of 0xFF fill bytes.
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      fail("malformed jpeg: file ends inside a marker prefix");
    }

    const marker = bytes[offset];
    offset += 1;

    if (marker === SOS) {
      reachedSos = true;
      break;
    }

    if (marker === EOI) {
      break;
    }

    if (isStandalone(marker)) {
      continue;
    }

    if (offset + 2 > bytes.length) {
      fail(`malformed jpeg: truncated length field for marker 0xFF${marker.toString(16).toUpperCase()}`);
    }

    const length = bytes.readUInt16BE(offset);
    if (length < 2) {
      fail(`malformed jpeg: invalid segment length ${length} for marker 0xFF${marker.toString(16).toUpperCase()}`);
    }

    const segmentStart = offset + 2;
    const segmentEnd = offset + length;
    if (segmentEnd > bytes.length) {
      fail(`malformed jpeg: segment 0xFF${marker.toString(16).toUpperCase()} runs past end of file`);
    }

    if ((marker === SOF0 || marker === SOF2) && frame === null) {
      if (segmentEnd - segmentStart < 5) {
        fail("malformed jpeg: start-of-frame segment is too short to hold dimensions");
      }
      const height = bytes.readUInt16BE(segmentStart + 1);
      const width = bytes.readUInt16BE(segmentStart + 3);
      frame = { width, height, marker };
    }

    offset = segmentEnd;
  }

  return { frame, reachedSos };
}

function main(): void {
  if (!existsSync(INPUT_FILE)) {
    fail(`could not find entry.png next to main.ts (looked at ${INPUT_FILE})`);
  }

  const bytes = readFileSync(INPUT_FILE);
  if (bytes.length < 4) {
    fail(`entry.png is too small to be a JPEG (${bytes.length} bytes)`);
  }

  if (bytes[0] !== 0xff || bytes[1] !== SOI) {
    fail("entry.png does not start with the JPEG SOI marker (FF D8)");
  }

  const { frame, reachedSos } = walkSegments(bytes);

  if (frame === null) {
    fail("malformed jpeg: no SOF0 (FF C0) or SOF2 (FF C2) start-of-frame segment found");
  }

  if (!reachedSos) {
    fail("malformed jpeg: marker walk never reached the SOS segment (FF DA)");
  }

  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== EOI) {
    fail("entry.png does not end with the JPEG EOI marker (FF D9)");
  }

  if (frame.width !== TARGET_WIDTH || frame.height !== TARGET_HEIGHT) {
    fail(`entry.png is ${frame.width}x${frame.height}, expected ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
  }

  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const outFile = join(outDir, "entry.png");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, bytes);

  const digest = createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(
    `entry.png: ${frame.width}x${frame.height} jpeg, ${bytes.length} bytes, sha256 ${digest}\n`,
  );

  process.exit(0);
}

main();
