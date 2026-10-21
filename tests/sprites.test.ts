import { describe, expect, it } from "vitest";
import {
  ACCESSORY,
  BODY,
  FRAME_H,
  FRAME_W,
  HAIR,
  HELD_MUG,
  TYPING_ROWS,
} from "../src/renderer/src/sprites/character-art";
import { lookFor, PALETTE_KEYS, renderCharacterFrame } from "../src/renderer/src/sprites/character";

const VALID = new RegExp(`^[.${PALETTE_KEYS}]{${FRAME_W}}$`);

function expectValidRows(name: string, rows: string[], maxRows: number) {
  expect(rows.length, name).toBeLessThanOrEqual(maxRows);
  rows.forEach((row, i) => expect(row, `${name} row ${i}`).toMatch(VALID));
}

describe("character art", () => {
  it("has full-size bodies with only known palette keys", () => {
    for (const [facing, frames] of Object.entries(BODY)) {
      for (const [frame, rows] of Object.entries(frames)) {
        expect(rows, `${facing}/${frame}`).toHaveLength(FRAME_H);
        expectValidRows(`body ${facing}/${frame}`, rows, FRAME_H);
      }
    }
  });

  it("keeps overlays within the head area", () => {
    for (const [style, facings] of Object.entries({ ...HAIR, ...ACCESSORY })) {
      for (const [facing, rows] of Object.entries(facings)) {
        expectValidRows(`${style}/${facing}`, rows, 16);
      }
    }
  });
});

describe("pose art", () => {
  it("keeps typing rows and held mugs valid", () => {
    for (const [pose, rows] of Object.entries(TYPING_ROWS)) expectValidRows(pose, rows, 2);
    for (const [facing, rows] of Object.entries(HELD_MUG)) {
      expectValidRows(`mug/${facing}`, rows, FRAME_H);
    }
  });

  it("changes pixels for typing and coffee poses", () => {
    const look = lookFor("agent-2", "gemini");
    const stand = renderCharacterFrame(look, "down", "stand");
    expect(renderCharacterFrame(look, "down", "typeA")).not.toEqual(stand);
    expect(renderCharacterFrame(look, "down", "typeB")).not.toEqual(stand);
    expect(renderCharacterFrame(look, "down", "coffee")).not.toEqual(stand);
    // Typing is only visible face-on; from behind the pose falls back to standing.
    expect(renderCharacterFrame(look, "up", "typeA")).toEqual(
      renderCharacterFrame(look, "up", "stand"),
    );
  });
});

describe("renderCharacterFrame", () => {
  it("is deterministic per agent and mirrors the side view", () => {
    const look = lookFor("agent-1", "codex");
    expect(lookFor("agent-1", "codex")).toEqual(look);
    const right = renderCharacterFrame(look, "right", "stand");
    const left = renderCharacterFrame(look, "left", "stand");
    const px = (buf: Uint8ClampedArray, x: number, y: number) =>
      Array.from(buf.subarray((y * FRAME_W + x) * 4, (y * FRAME_W + x) * 4 + 4));
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++)
        expect(px(left, x, y)).toEqual(px(right, FRAME_W - 1 - x, y));
    }
  });
});
