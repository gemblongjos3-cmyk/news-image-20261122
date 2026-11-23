import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(SELF_DIR, "entry.png");

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function main(): void {
  if (!existsSync(INPUT_FILE)) {
    fail(`could not find entry.png next to main.ts (looked at ${INPUT_FILE})`);
  }

  const bytes = readFileSync(INPUT_FILE);
  if (bytes.length < 4) {
    fail(`entry.png is too small to be a JPEG (${bytes.length} bytes)`);
  }

  const isSoi = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isSoi) {
    fail("entry.png does not start with the JPEG SOI marker (FF D8)");
  }

  const last = bytes.length;
  const isEoi = bytes[last - 2] === 0xff && bytes[last - 1] === 0xd9;
  if (!isEoi) {
    fail("entry.png does not end with the JPEG EOI marker (FF D9)");
  }

  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const outFile = join(outDir, "entry.png");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, bytes);

  process.exit(0);
}

main();
