import {
  CELLS,
  feetOf,
  FURNITURE,
  MAP_H,
  MAP_W,
  SEATS,
  type FloorKind,
  type Furniture,
  type Seat,
} from "../../shared/engine/office-map";

// Procedural pixel art for the office. Everything is drawn at 1x on a 16 px grid; the
// caller scales the result by an integer factor.

const T = 16;
const OUTLINE = "#2a1f2e";

type Ctx = CanvasRenderingContext2D;

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Filled rectangle with a 1 px outline. */
function box(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string, line = OUTLINE) {
  rect(ctx, x, y, w, h, line);
  rect(ctx, x + 1, y + 1, w - 2, h - 2, fill);
}

/** Deterministic per-tile noise so textures don't look tiled. */
function noise(x: number, y: number, salt = 0): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- floors

function drawFloor(ctx: Ctx, kind: FloorKind, tx: number, ty: number): void {
  const x = tx * T;
  const y = ty * T;
  switch (kind) {
    case "wood": {
      rect(ctx, x, y, T, T, "#9a6a45");
      for (let i = 0; i < 4; i++) {
        const py = y + i * 4;
        rect(ctx, x, py + 3, T, 1, "#7d5235");
        // Staggered plank seams.
        const seam = (tx * 7 + i * 5 + (ty % 2) * 3) % T;
        rect(ctx, x + seam, py, 1, 3, "#7d5235");
        if (noise(tx, ty, i) > 0.6) rect(ctx, x + ((seam + 6) % 14), py + 1, 2, 1, "#a8774f");
      }
      break;
    }
    case "tile": {
      rect(ctx, x, y, T, T, "#cfd4de");
      rect(ctx, x, y, T, 1, "#b3b9c6");
      rect(ctx, x, y, 1, T, "#b3b9c6");
      rect(ctx, x + 8, y, 1, T, "#bfc5d1");
      rect(ctx, x, y + 8, T, 1, "#bfc5d1");
      break;
    }
    case "metal": {
      rect(ctx, x, y, T, T, "#4d5563");
      rect(ctx, x, y, T, 1, "#5d6676");
      rect(ctx, x, y + 15, T, 1, "#3b414d");
      rect(ctx, x + 15, y, 1, T, "#3b414d");
      for (const [px, py] of [
        [2, 2],
        [13, 2],
        [2, 13],
        [13, 13],
      ])
        rect(ctx, x + px!, y + py!, 1, 1, "#78829a");
      break;
    }
    case "carpet":
    case "meeting":
    case "hall": {
      const [base, fleck] =
        kind === "carpet"
          ? ["#3e6a4f", "#477759"]
          : kind === "meeting"
            ? ["#584a70", "#62537b"]
            : ["#5a5d6a", "#636775"];
      rect(ctx, x, y, T, T, base);
      for (let i = 0; i < 10; i++) {
        rect(
          ctx,
          x + Math.floor(noise(tx, ty, i) * T),
          y + Math.floor(noise(ty, tx, i + 9) * T),
          1,
          1,
          fleck,
        );
      }
      break;
    }
    case "marble": {
      const dark = (tx + ty) % 2 === 0;
      rect(ctx, x, y, T, T, dark ? "#c2bba9" : "#ddd7c9");
      if (noise(tx, ty) > 0.5) rect(ctx, x + 3, y + 5, 6, 1, dark ? "#b3ac9a" : "#cfc8b8");
      break;
    }
    case "checker": {
      for (let i = 0; i < 4; i++) {
        const cx = (i % 2) * 8;
        const cy = Math.floor(i / 2) * 8;
        rect(ctx, x + cx, y + cy, 8, 8, i === 0 || i === 3 ? "#e9e5da" : "#3d3d48");
      }
      break;
    }
  }
}

// ---------------------------------------------------------------- walls

const isWall = (x: number, y: number) => CELLS[y]?.[x]?.wall ?? true;

function drawWall(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * T;
  const y = ty * T;
  const faceVisible = !isWall(tx, ty + 1);
  if (faceVisible) {
    // Front face seen from the room below: cap, wallpaper, baseboard.
    rect(ctx, x, y, T, 4, "#3a3346");
    rect(ctx, x, y + 4, T, 10, "#a9a3bd");
    rect(ctx, x, y + 4, T, 1, "#c4bfd4");
    if (tx % 2 === 0) rect(ctx, x + 7, y + 6, 1, 7, "#9a94ae");
    rect(ctx, x, y + 14, T, 2, "#5e5672");
  } else {
    rect(ctx, x, y, T, T, "#3a3346");
    rect(ctx, x + 2, y + 2, 12, 12, "#332d3e");
  }
  // Light rim where the wall top meets floor on the sides.
  if (!isWall(tx - 1, ty)) rect(ctx, x, y, 1, faceVisible ? 4 : T, "#504761");
  if (!isWall(tx + 1, ty)) rect(ctx, x + 15, y, 1, faceVisible ? 4 : T, "#504761");
}

function drawWindow(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * T;
  const y = ty * T;
  box(ctx, x + 1, y + 5, 14, 9, "#9fd3f0", "#5e5672");
  rect(ctx, x + 2, y + 6, 12, 3, "#c6e8fa");
  rect(ctx, x + 8, y + 5, 1, 9, "#5e5672");
  rect(ctx, x + 3, y + 7, 3, 1, "#ffffff");
}

function drawWhiteboard(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * T;
  const y = ty * T;
  box(ctx, x + 2, y + 4, 28, 11, "#f4f4f6", "#6b6f7e");
  rect(ctx, x + 5, y + 7, 9, 1, "#3d7bd9");
  rect(ctx, x + 5, y + 9, 14, 1, "#d94a4a");
  rect(ctx, x + 18, y + 6, 6, 5, "#46a36b");
}

function drawPoster(ctx: Ctx, tx: number, ty: number, color: string): void {
  const x = tx * T;
  const y = ty * T;
  box(ctx, x + 4, y + 5, 8, 9, color, "#3a3346");
  rect(ctx, x + 6, y + 7, 4, 2, "#ffffffaa");
}

function drawClock(ctx: Ctx, tx: number, ty: number): void {
  const x = tx * T + 5;
  const y = ty * T + 5;
  box(ctx, x, y, 7, 7, "#f4f1e8");
  rect(ctx, x + 3, y + 2, 1, 2, OUTLINE);
  rect(ctx, x + 3, y + 3, 2, 1, OUTLINE);
}

/** Static layer: floors, walls and wall decorations. */
export function drawBackground(ctx: Ctx): void {
  for (let ty = 0; ty < MAP_H; ty++) {
    for (let tx = 0; tx < MAP_W; tx++) {
      const cell = CELLS[ty]![tx]!;
      if (cell.wall) drawWall(ctx, tx, ty);
      else drawFloor(ctx, cell.floor, tx, ty);
    }
  }
  // Windows along the top wall of the work rooms.
  for (let tx = 2; tx < MAP_W - 1; tx += 3) if (!isWall(tx, 1)) drawWindow(ctx, tx, 0);
  drawWhiteboard(ctx, 35, 13);
  drawPoster(ctx, 9, 13, "#d97757");
  drawPoster(ctx, 29, 13, "#4285f4");
  drawPoster(ctx, 29, 18, "#10a37f");
  drawClock(ctx, 35, 18);
  // Entrance mat.
  rect(ctx, 19 * T, 22 * T + 6, 2 * T, 10, "#6a3b3b");
  rect(ctx, 19 * T + 2, 22 * T + 8, 2 * T - 4, 6, "#874c4c");
}

// ---------------------------------------------------------------- furniture

function drawDesk(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, x + 1, y + 14, w - 2, 2, "#00000040");
  // Monitor back, set to one side so the agent's face stays visible.
  box(ctx, x + 1, y - 16, 10, 10, "#3d4150", "#1e1e26");
  rect(ctx, x + 3, y - 14, 6, 1, "#4b5060");
  rect(ctx, x + 5, y - 7, 2, 2, "#2a2c35");
  box(ctx, x, y - 6, w, 11, "#c48d5c", "#3b2a20");
  rect(ctx, x + 1, y - 5, w - 2, 1, "#dba675");
  box(ctx, x, y + 4, w, 10, "#8e5e3a", "#3b2a20");
  box(ctx, x + w - 12, y + 6, 9, 5, "#7a4f30", "#5a3a22");
  rect(ctx, x + w - 8, y + 8, 1, 1, "#e0c070");
  rect(ctx, x + 1, y + 13, 2, 2, "#3b2a20");
  rect(ctx, x + w - 3, y + 13, 2, 2, "#3b2a20");
  // Mug and papers.
  box(ctx, x + w - 8, y - 9, 4, 5, "#e8e4da");
  rect(ctx, x + 18, y - 4, 6, 4, "#f4f1e8");
}

function drawChair(ctx: Ctx, cx: number, feetY: number, facing: Seat["facing"]): void {
  if (facing === "up") {
    // Seen from behind: the backrest hides the agent's lower back.
    box(ctx, cx - 6, feetY - 14, 12, 10, "#3f455a");
    rect(ctx, cx - 5, feetY - 13, 10, 1, "#535a72");
    rect(ctx, cx - 1, feetY - 4, 2, 4, "#22252e");
    return;
  }
  box(ctx, cx - 7, feetY - 22, 14, 13, "#3f455a");
  rect(ctx, cx - 6, feetY - 21, 12, 1, "#535a72");
  rect(ctx, cx - 1, feetY - 9, 2, 6, "#22252e");
  rect(ctx, cx - 5, feetY - 3, 10, 2, "#22252e");
}

function drawPlant(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x + 3, y + 14, 10, 2, "#00000040");
  box(ctx, x + 4, y + 7, 8, 8, "#b5653c");
  rect(ctx, x + 5, y + 8, 6, 1, "#cf7d50");
  const leaves: [number, number, number, number, string][] = [
    [6, -6, 4, 6, "#2f7a45"],
    [2, -2, 6, 5, "#3d9455"],
    [8, -3, 6, 5, "#3d9455"],
    [4, 1, 8, 6, "#2f7a45"],
    [5, -1, 3, 2, "#5cb873"],
    [9, 0, 2, 2, "#5cb873"],
  ];
  for (const [lx, ly, w, h, c] of leaves) box(ctx, x + lx, y + ly, w, h, c, "#1f4d2c");
}

function drawBookshelf(ctx: Ctx, x: number, y: number, w: number): void {
  box(ctx, x, y - 14, w, 30, "#7a5236", "#3b2a20");
  const colors = ["#c0503b", "#3d7bd9", "#e3b341", "#46a36b", "#9b6bd1", "#e8e4da"];
  for (const shelf of [-12, -3, 6]) {
    rect(ctx, x + 1, y + shelf + 8, w - 2, 1, "#5a3a22");
    for (let bx = x + 2; bx < x + w - 3; bx += 3) {
      const h = 5 + Math.floor(noise(bx, shelf) * 3);
      rect(ctx, bx, y + shelf + 8 - h, 2, h, colors[Math.floor(noise(shelf, bx) * colors.length)]!);
    }
  }
}

function drawServer(ctx: Ctx, x: number, y: number, t: number): void {
  box(ctx, x + 1, y - 14, 14, 30, "#2b2f3a", "#15171d");
  for (let i = 0; i < 6; i++) {
    const ry = y - 12 + i * 4;
    rect(ctx, x + 3, ry, 10, 3, "#383d4b");
    const on = noise(i, Math.floor(t * 3) + x) > 0.4;
    rect(ctx, x + 4, ry + 1, 1, 1, on ? "#5cff8a" : "#2a5a3a");
    rect(ctx, x + 6, ry + 1, 1, 1, noise(x, i + Math.floor(t * 2)) > 0.7 ? "#ffb347" : "#4a3a20");
  }
}

function drawMeetingTable(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  rect(ctx, x + 2, y + h - 2, w - 4, 3, "#00000040");
  box(ctx, x, y - 2, w, h - 4, "#8a5a3a", "#3b2a20");
  rect(ctx, x + 1, y - 1, w - 2, 1, "#a8774f");
  box(ctx, x, y + h - 7, w, 6, "#6b4429", "#3b2a20");
  // Laptops and notes.
  for (const lx of [x + 18, x + 50, x + 82]) {
    box(ctx, lx, y + 3, 10, 7, "#b8bfcc", "#4a5060");
    rect(ctx, lx + 2, y + 4, 6, 1, "#ffffff");
  }
  rect(ctx, x + 36, y + 14, 6, 5, "#f2c94c");
  rect(ctx, x + 68, y + 12, 6, 5, "#f4f1e8");
}

function drawCounter(ctx: Ctx, x: number, y: number, w: number, t: number): void {
  box(ctx, x, y - 6, w, 10, "#a3a9b3", "#3a3346");
  rect(ctx, x + 1, y - 5, w - 2, 1, "#c3c8d0");
  box(ctx, x, y + 3, w, 13, "#6e5a48", "#3a3346");
  for (let dx = 4; dx < w - 4; dx += 16) {
    rect(ctx, x + dx, y + 5, 12, 9, "#7d6853");
    rect(ctx, x + dx + 10, y + 9, 1, 2, "#d8c9a8");
  }
  // Coffee machine above the second tile.
  const mx = x + 18;
  box(ctx, mx, y - 20, 12, 15, "#2a2a30", "#111114");
  rect(ctx, mx + 2, y - 18, 8, 3, "#44444c");
  rect(ctx, mx + 8, y - 14, 2, 2, "#e04848");
  rect(ctx, mx + 4, y - 9, 4, 3, "#e8e4da");
  for (let i = 0; i < 3; i++) {
    const sy = y - 22 - i * 3 - Math.floor((t * 6) % 3);
    rect(ctx, mx + 5 + ((i + Math.floor(t * 4)) % 2), sy, 1, 2, "#ffffff66");
  }
  // Sink.
  rect(ctx, x + 66, y - 5, 14, 5, "#7a8a96");
  rect(ctx, x + 72, y - 9, 2, 4, "#c3c8d0");
  // Kettle.
  box(ctx, x + 50, y - 12, 7, 7, "#d94a4a");
}

function drawFridge(ctx: Ctx, x: number, y: number): void {
  box(ctx, x + 1, y - 16, 14, 31, "#e3e7ec", "#4a5060");
  rect(ctx, x + 2, y - 5, 12, 1, "#a9b0bb");
  rect(ctx, x + 11, y - 12, 1, 5, "#7a8290");
  rect(ctx, x + 11, y - 2, 1, 6, "#7a8290");
  rect(ctx, x + 4, y - 13, 3, 3, "#f2c94c");
}

function drawCafeTable(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x + 3, y + 13, 10, 2, "#00000040");
  rect(ctx, x + 7, y + 4, 2, 10, "#3b2a20");
  box(ctx, x + 1, y - 2, 14, 7, "#d8bf92", "#5a3a22");
  rect(ctx, x + 6, y - 1, 3, 2, "#ffffff");
}

function drawReceptionDesk(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, x + 1, y + 14, w - 2, 2, "#00000040");
  box(ctx, x, y - 8, w, 9, "#e2dccd", "#3a3346");
  box(ctx, x, y, w, 15, "#46597d", "#2a3550");
  rect(ctx, x + 2, y + 2, w - 4, 1, "#5d74a0");
  rect(ctx, x + w / 2 - 12, y + 6, 24, 5, "#e3b341");
  box(ctx, x + 6, y - 16, 12, 9, "#3d4150", "#1e1e26");
  box(ctx, x + w - 14, y - 11, 5, 4, "#e3b341");
}

function drawSofa(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, x + 1, y + 14, w - 2, 2, "#00000040");
  box(ctx, x, y - 8, w, 10, "#8a4256");
  box(ctx, x, y + 1, w, 13, "#a3506a");
  for (let cx = x + 3; cx < x + w - 8; cx += 15) rect(ctx, cx, y + 3, 13, 5, "#b8607b");
  box(ctx, x - 1, y - 2, 5, 15, "#8a4256");
  box(ctx, x + w - 4, y - 2, 5, 15, "#8a4256");
}

function drawWaterCooler(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x + 3, y + 14, 10, 2, "#00000040");
  box(ctx, x + 4, y - 14, 8, 10, "#8ec5ff", "#3d6a9a");
  rect(ctx, x + 6, y - 12, 2, 6, "#c6e3ff");
  box(ctx, x + 3, y - 5, 10, 20, "#e8e8f0", "#4a5060");
  rect(ctx, x + 6, y + 1, 4, 2, "#3d7bd9");
}

function drawPrinter(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x + 1, y + 14, 14, 2, "#00000040");
  box(ctx, x + 1, y - 4, 14, 18, "#d0d0d8", "#4a5060");
  rect(ctx, x + 3, y - 7, 10, 4, "#ffffff");
  rect(ctx, x + 3, y + 1, 10, 2, "#2a2c35");
  rect(ctx, x + 11, y + 6, 2, 1, "#5cff8a");
}

export interface Drawable {
  /** Screen y used for painter's sorting (bottom of the object, 1x pixels). */
  baseline: number;
  draw(ctx: Ctx, t: number): void;
}

function furnitureDrawable(f: Furniture): Drawable {
  const x = f.x * T;
  const y = f.y * T;
  const w = f.w * T;
  const h = f.h * T;
  const baseline = y + h;
  const draw = (fn: (ctx: Ctx, t: number) => void): Drawable => ({ baseline, draw: fn });
  switch (f.kind) {
    case "desk":
      return draw((c) => drawDesk(c, x, y, w));
    case "plant":
      return draw((c) => drawPlant(c, x, y));
    case "bookshelf":
      return draw((c) => drawBookshelf(c, x, y, w));
    case "server":
      return draw((c, t) => drawServer(c, x, y, t));
    case "meetingTable":
      return draw((c) => drawMeetingTable(c, x, y, w, h));
    case "counter":
      return draw((c, t) => drawCounter(c, x, y, w, t));
    case "fridge":
      return draw((c) => drawFridge(c, x, y));
    case "cafeTable":
      return draw((c) => drawCafeTable(c, x, y));
    case "receptionDesk":
      return draw((c) => drawReceptionDesk(c, x, y, w));
    case "sofa":
      return draw((c) => drawSofa(c, x, y, w));
    case "waterCooler":
      return draw((c) => drawWaterCooler(c, x, y));
    case "printer":
      return draw((c) => drawPrinter(c, x, y));
  }
}

function chairDrawable(seat: Seat): Drawable {
  const feet = feetOf(seat);
  // Backrest behind a seated agent facing us, in front of one facing away.
  const baseline = seat.facing === "up" ? feet.y + 1 : feet.y - 1;
  return { baseline, draw: (c) => drawChair(c, feet.x, feet.y, seat.facing) };
}

export const SCENERY: readonly Drawable[] = [
  ...FURNITURE.map(furnitureDrawable),
  ...SEATS.filter((s) => s.sit).map(chairDrawable),
];
