import type { Source } from "../../../shared/protocol/schema";
import {
  ACCESSORY,
  BODY,
  FRAME_H,
  FRAME_W,
  HAIR,
  HELD_MUG,
  TYPING_ROWS,
  type Accessory,
  type Facing,
  type HairStyle,
  type WalkFrame,
} from "./character-art";

// Pure pixel compositing (no DOM), so it runs both in the renderer and in Node scripts.

export type Rgba = readonly [number, number, number, number];

export interface CharacterLook {
  skin: [string, string];
  hair: [string, string];
  top: [string, string, string];
  pants: [string, string];
  hairStyle: HairStyle;
  accessory: Accessory;
  accessoryColor: [string, string];
}

const OUTLINE = "#2a1f2e";
const EYE = "#1b1b24";
const MOUTH = "#9a4f3e";
const SHOES = "#2e2529";
const WHITE = "#f4f1e8";

const SKINS: [string, string][] = [
  ["#f6d3b3", "#dfb08c"],
  ["#e8b58c", "#c99470"],
  ["#c98e62", "#a8744d"],
  ["#8d5a3b", "#6e432b"],
  ["#5c3a26", "#45291a"],
];

const HAIRS: [string, string][] = [
  ["#2b2220", "#171112"],
  ["#5a3825", "#3e2416"],
  ["#a86a32", "#80501f"],
  ["#e5c06a", "#bf9a44"],
  ["#b7b7c4", "#8b8b9b"],
  ["#c0503b", "#92372a"],
];

const PANTS: [string, string][] = [
  ["#3b4a6b", "#2a3550"],
  ["#4a4a52", "#34343b"],
  ["#5b4a3a", "#433528"],
  ["#2f3640", "#20252d"],
];

const HAIR_STYLES: HairStyle[] = ["short", "long", "bun", "spiky"];

/** Team colors: the top is the first thing you read, the accessory confirms it. */
export const SOURCE_STYLE: Record<
  Source,
  { top: [string, string, string]; accessory: Accessory; accessoryColor: [string, string] }
> = {
  "claude-code": {
    top: ["#d97757", "#ad5638", "#f6c9b0"],
    accessory: "none",
    accessoryColor: ["#000000", "#000000"],
  },
  codex: {
    top: ["#10a37f", "#0b7559", "#8be3c9"],
    accessory: "headphones",
    accessoryColor: ["#4a4a5c", "#2c2c38"],
  },
  gemini: {
    top: ["#4285f4", "#2b5fc2", "#b3cdfb"],
    accessory: "glasses",
    accessoryColor: ["#1e1e28", "#1e1e28"],
  },
  custom: {
    top: ["#9b6bd1", "#7046a3", "#d8c1f2"],
    accessory: "cap",
    accessoryColor: ["#e3b341", "#b58a25"],
  },
};

/** FNV-1a: stable per-agent variety without storing anything. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function lookFor(agentId: string, source: Source): CharacterLook {
  const h = hash(agentId);
  const pick = <T>(items: readonly T[], salt: number): T => items[(h >>> salt) % items.length]!;
  return {
    skin: pick(SKINS, 0),
    hair: pick(HAIRS, 5),
    pants: pick(PANTS, 10),
    hairStyle: pick(HAIR_STYLES, 15),
    ...SOURCE_STYLE[source],
  };
}

function hexToRgba(hex: string): Rgba {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function paletteFor(look: CharacterLook): Record<string, Rgba> {
  const p: Record<string, string> = {
    o: OUTLINE,
    s: look.skin[0],
    S: look.skin[1],
    e: EYE,
    m: MOUTH,
    h: look.hair[0],
    H: look.hair[1],
    c: look.top[0],
    C: look.top[1],
    l: look.top[2],
    p: look.pants[0],
    P: look.pants[1],
    b: SHOES,
    a: look.accessoryColor[0],
    A: look.accessoryColor[1],
    w: WHITE,
  };
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, hexToRgba(v)]));
}

export const PALETTE_KEYS = "osSemhHcClpPbaAw";

function stamp(
  out: Uint8ClampedArray,
  rows: readonly string[],
  palette: Record<string, Rgba>,
  mirror: boolean,
): void {
  rows.forEach((row, y) => {
    for (let x = 0; x < FRAME_W; x++) {
      const key = row[x];
      if (!key || key === ".") continue;
      const color = palette[key];
      if (!color) continue;
      const tx = mirror ? FRAME_W - 1 - x : x;
      out.set(color, (y * FRAME_W + tx) * 4);
    }
  });
}

export type Direction = "down" | "up" | "left" | "right";

/** Walk frames plus the seated/idle poses. Typing only differs from standing face-on. */
export type Pose = WalkFrame | "typeA" | "typeB" | "coffee";

/** Renders one 16x32 RGBA frame. */
export function renderCharacterFrame(
  look: CharacterLook,
  direction: Direction,
  pose: Pose,
): Uint8ClampedArray<ArrayBuffer> {
  const facing: Facing = direction === "left" || direction === "right" ? "side" : direction;
  const mirror = direction === "left";
  const palette = paletteFor(look);
  const out = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);

  const frame: WalkFrame = pose === "stepA" || pose === "stepB" ? pose : "stand";
  let body = BODY[facing][frame];
  if ((pose === "typeA" || pose === "typeB") && facing === "down") {
    body = [...body.slice(0, 22), ...TYPING_ROWS[pose], ...body.slice(24)];
  }
  stamp(out, body, palette, mirror);
  // Headphones and caps go over the hair, glasses too (they sit on the face).
  stamp(out, HAIR[look.hairStyle][facing], palette, mirror);
  if (look.accessory !== "none") stamp(out, ACCESSORY[look.accessory][facing], palette, mirror);
  if (pose === "coffee") stamp(out, HELD_MUG[facing], palette, mirror);
  return out;
}
