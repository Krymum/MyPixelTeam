// Renders every character variant into a PNG contact sheet for eyeballing pixel art.
// Usage: npx tsx scripts/sprite-preview.ts [out.png]
import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { FRAME_H, FRAME_W, type HairStyle } from "../src/renderer/src/sprites/character-art";
import {
  lookFor,
  renderCharacterFrame,
  SOURCE_STYLE,
  type Direction,
} from "../src/renderer/src/sprites/character";
import { SOURCES } from "../src/shared/protocol/schema";

const SCALE = 4;
const GAP = 2;
const out = process.argv[2] ?? "sprite-preview.png";

const columns: [Direction, "stand" | "stepA" | "stepB"][] = [
  ["down", "stand"],
  ["down", "stepA"],
  ["down", "stepB"],
  ["up", "stand"],
  ["up", "stepA"],
  ["right", "stand"],
  ["right", "stepA"],
  ["right", "stepB"],
  ["left", "stand"],
  ["left", "stepA"],
];
const styles: HairStyle[] = ["short", "long", "bun", "spiky"];

const cellW = FRAME_W + GAP;
const cellH = FRAME_H + GAP;
const width = columns.length * cellW * SCALE;
const height = SOURCES.length * styles.length * cellH * SCALE;
const pixels = new Uint8Array(width * height * 4).fill(0);
for (let i = 0; i < pixels.length; i += 4) pixels.set([60, 60, 74, 255], i);

let row = 0;
for (const source of SOURCES) {
  styles.forEach((hairStyle, i) => {
    const look = {
      ...lookFor(`preview-${source}-${i}`, source),
      hairStyle,
      ...SOURCE_STYLE[source],
    };
    columns.forEach(([direction, frame], col) => {
      const sprite = renderCharacterFrame(look, direction, frame);
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) {
          const src = (y * FRAME_W + x) * 4;
          if (sprite[src + 3] === 0) continue;
          for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) {
              const px = (col * cellW + x) * SCALE + dx;
              const py = (row * cellH + y) * SCALE + dy;
              pixels.set(sprite.subarray(src, src + 4), (py * width + px) * 4);
            }
          }
        }
      }
    });
    row++;
  });
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y++) {
  raw[y * (width * 4 + 1)] = 0;
  Buffer.from(pixels.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
}
writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log(`wrote ${out} (${width}x${height})`);
