import type { Source } from "../../../shared/protocol/schema";
import { FRAME_H, FRAME_W } from "./character-art";
import { lookFor, renderCharacterFrame, type Direction, type Pose } from "./character";

const cache = new Map<string, HTMLCanvasElement>();

/** Returns (and memoizes) the 16x32 canvas for one agent pose. */
export function characterSprite(
  agentId: string,
  source: Source,
  direction: Direction,
  pose: Pose,
): HTMLCanvasElement {
  const key = `${agentId}|${direction}|${pose}`;
  let canvas = cache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = FRAME_W;
    canvas.height = FRAME_H;
    const pixels = renderCharacterFrame(lookFor(agentId, source), direction, pose);
    canvas.getContext("2d")!.putImageData(new ImageData(pixels, FRAME_W, FRAME_H), 0, 0);
    cache.set(key, canvas);
  }
  return canvas;
}

export function forgetCharacter(agentId: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${agentId}|`)) cache.delete(key);
}
