/**
 * Writes the app icons from the pixel logo: resources/icon.ico and icon.png for the window, and
 * build/icon.png and build/icon.ico for electron-builder. Run with `npm run icon`.
 * Pixel art scales by whole multiples, so every size is drawn nearest-neighbour.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { LOGO_ROWS, logoPixels } from "../src/shared/logo";

const GRID = LOGO_ROWS.length;

function rgba(size: number): Buffer {
  const scale = size / GRID;
  const data = Buffer.alloc(size * size * 4);
  for (const { x, y, color } of logoPixels()) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    for (let dy = Math.floor(y * scale); dy < Math.floor((y + 1) * scale); dy++)
      for (let dx = Math.floor(x * scale); dx < Math.floor((x + 1) * scale); dx++)
        data.set([r!, g!, b!, 255], (dy * size + dx) * 4);
  }
  return data;
}

function png(size: number): Buffer {
  const pixels = rgba(size);
  // Each row starts with filter byte 0 (none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A 32-bit icon bitmap: bottom-up BGRA, then an all-zero AND mask (alpha does the work). */
function bmp(size: number): Buffer {
  const pixels = rgba(size);
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(size, 4);
  info.writeInt32LE(size * 2, 8); // colour rows, then mask rows
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      colour.set([pixels[from + 2]!, pixels[from + 1]!, pixels[from]!, pixels[from + 3]!], to);
    }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([info, colour, mask]);
}

/** An .ico: bitmaps for the small sizes, PNG for 256 as Windows expects. */
function ico(sizes: number[]): Buffer {
  const images = sizes.map((size) => (size >= 256 ? png(size) : bmp(size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(images[i]!.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += images[i]!.length;
  });
  return Buffer.concat([header, ...images]);
}

const root = join(import.meta.dirname, "..");
for (const dir of ["resources", "build"]) mkdirSync(join(root, dir), { recursive: true });
const windowsIcon = ico([16, 32, 48, 64, 128, 256]);
writeFileSync(join(root, "resources", "icon.png"), png(256));
writeFileSync(join(root, "resources", "icon.ico"), windowsIcon);
writeFileSync(join(root, "build", "icon.png"), png(512));
writeFileSync(join(root, "build", "icon.ico"), windowsIcon);
console.log("icons written to resources/ and build/");
