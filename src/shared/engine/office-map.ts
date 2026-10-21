/**
 * The office floor plan: walls, floors, furniture footprints and seats, in 16 px tiles.
 * Pure data shared by the engine (pathfinding, seat assignment) and the renderer.
 */

export const TILE = 16;
export const MAP_W = 40;
export const MAP_H = 24;

/** Feet position of a character standing on a tile, in 1x pixels. */
export function feetOf(spot: { x: number; y: number; offsetX?: number }): {
  x: number;
  y: number;
} {
  return { x: spot.x * TILE + TILE / 2 + (spot.offsetX ?? 0), y: spot.y * TILE + 13 };
}

export type ZoneId =
  "dev" | "qa" | "ops" | "research" | "meeting" | "kitchen" | "reception" | "hall";

export type FloorKind =
  "wood" | "tile" | "metal" | "carpet" | "marble" | "meeting" | "checker" | "hall";

export type Facing = "down" | "up" | "left" | "right";

export interface Zone {
  id: ZoneId;
  label: string;
  /** Interior rectangle, inclusive of x..x+w-1, y..y+h-1. */
  x: number;
  y: number;
  w: number;
  h: number;
  floor: FloorKind;
}

export const ZONES: Record<ZoneId, Zone> = {
  dev: { id: "dev", label: "DEV", x: 1, y: 1, w: 12, h: 9, floor: "wood" },
  qa: { id: "qa", label: "QA", x: 14, y: 1, w: 12, h: 9, floor: "tile" },
  ops: { id: "ops", label: "OPS", x: 27, y: 1, w: 12, h: 9, floor: "metal" },
  hall: { id: "hall", label: "", x: 1, y: 11, w: 38, h: 2, floor: "hall" },
  research: { id: "research", label: "RESEARCH & DOCS", x: 1, y: 14, w: 12, h: 9, floor: "carpet" },
  reception: { id: "reception", label: "RECEPTION", x: 14, y: 13, w: 12, h: 10, floor: "marble" },
  meeting: { id: "meeting", label: "MEETING", x: 27, y: 14, w: 12, h: 4, floor: "meeting" },
  kitchen: { id: "kitchen", label: "KITCHEN", x: 27, y: 19, w: 12, h: 4, floor: "checker" },
};

/** Gaps in walls, as [x, y] tiles. */
const DOORS: [number, number][] = [
  [5, 10],
  [6, 10], // dev
  [19, 10],
  [20, 10], // qa
  [32, 10],
  [33, 10], // ops
  [5, 13],
  [6, 13], // research
  [32, 13],
  [33, 13], // meeting
  [26, 20],
  [26, 21], // kitchen, from reception
  [19, 23],
  [20, 23], // main entrance
];

export type FurnitureKind =
  | "desk"
  | "plant"
  | "bookshelf"
  | "server"
  | "meetingTable"
  | "counter"
  | "fridge"
  | "cafeTable"
  | "receptionDesk"
  | "sofa"
  | "waterCooler"
  | "printer";

export interface Furniture {
  kind: FurnitureKind;
  /** Blocked footprint in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Seat {
  id: string;
  zone: ZoneId;
  /** Tile the agent walks to. */
  x: number;
  y: number;
  facing: Facing;
  /** Sitting on a chair (desk, meeting) rather than standing (kitchen, reception). */
  sit: boolean;
  /** Horizontal pixel offset, e.g. to center an agent on a two-tile desk. */
  offsetX: number;
}

const furniture: Furniture[] = [];
const seats: Seat[] = [];

function add(kind: FurnitureKind, x: number, y: number, w = 1, h = 1): void {
  furniture.push({ kind, x, y, w, h });
}

function seat(zone: ZoneId, x: number, y: number, facing: Facing, sit: boolean, offsetX = 0) {
  seats.push({
    id: `${zone}-${seats.filter((s) => s.zone === zone).length + 1}`,
    zone,
    x,
    y,
    facing,
    sit,
    offsetX,
  });
}

/** A two-tile desk with its chair behind it; the agent faces the viewer. */
function deskWithSeat(zone: ZoneId, x: number, y: number): void {
  add("desk", x, y, 2, 1);
  seat(zone, x, y - 1, "down", true, 8);
}

// Dev, QA and Ops: two rows of three desks.
for (const [zone, x0] of [
  ["dev", 2],
  ["qa", 15],
  ["ops", 28],
] as const) {
  for (const row of [4, 8]) for (let i = 0; i < 3; i++) deskWithSeat(zone, x0 + i * 3, row);
}
add("plant", 12, 1);
add("plant", 12, 9);
add("printer", 1, 9);
add("plant", 25, 1);
add("waterCooler", 25, 9);
add("server", 37, 2);
add("server", 38, 2);
add("plant", 27, 9);

// Research: bookshelves against the top wall, then two rows of desks.
add("bookshelf", 1, 14, 3, 1);
add("bookshelf", 8, 14, 3, 1);
for (const row of [17, 21]) for (let i = 0; i < 3; i++) deskWithSeat("research", 2 + i * 3, row);
add("plant", 12, 14);
add("plant", 12, 22);

// Meeting: one long table with chairs on both sides.
add("meetingTable", 29, 15, 8, 2);
for (const x of [30, 32, 34]) seat("meeting", x, 14, "down", true, 8);
for (const x of [30, 32, 34]) seat("meeting", x, 17, "up", true, 8);
seat("meeting", 28, 15, "right", true);
seat("meeting", 37, 15, "left", true);

// Kitchen: counter with the coffee machine, fridge, two café tables to hang around.
add("counter", 27, 19, 6, 1);
add("fridge", 38, 19);
add("cafeTable", 30, 21);
add("cafeTable", 35, 21);
seat("kitchen", 29, 20, "up", false); // in front of the coffee machine
for (const [x, y, f] of [
  [29, 21, "right"],
  [31, 21, "left"],
  [30, 22, "up"],
  [34, 21, "right"],
  [36, 21, "left"],
  [35, 22, "up"],
  [33, 20, "down"],
  [37, 20, "down"],
] as const)
  seat("kitchen", x, y, f, false);

// Reception: front desk, sofa and a waiting line.
add("receptionDesk", 18, 16, 4, 1);
add("sofa", 14, 21, 3, 1);
add("plant", 25, 22);
add("plant", 14, 13);
add("plant", 25, 13);
for (const x of [16, 18, 21, 23]) seat("reception", x, 19, "down", false);

export const FURNITURE: readonly Furniture[] = furniture;
export const SEATS: readonly Seat[] = seats;

/** Where new agents appear: just inside the main entrance. */
export const ENTRANCE = { x: 19, y: 22 } as const;

export type Cell = { wall: true } | { wall: false; zone: ZoneId; floor: FloorKind };

function buildCells(): Cell[][] {
  const cells: Cell[][] = Array.from({ length: MAP_H }, () =>
    Array.from({ length: MAP_W }, (): Cell => ({ wall: true })),
  );
  for (const z of Object.values(ZONES)) {
    for (let y = z.y; y < z.y + z.h; y++) {
      for (let x = z.x; x < z.x + z.w; x++)
        cells[y]![x] = { wall: false, zone: z.id, floor: z.floor };
    }
  }
  for (const [x, y] of DOORS) cells[y]![x] = { wall: false, zone: "hall", floor: "hall" };
  return cells;
}

export const CELLS: readonly (readonly Cell[])[] = buildCells();

const blocked = new Set(
  FURNITURE.flatMap((f) =>
    Array.from({ length: f.w * f.h }, (_, i) => `${f.x + (i % f.w)},${f.y + Math.floor(i / f.w)}`),
  ),
);

export function isWalkable(x: number, y: number): boolean {
  const cell = CELLS[y]?.[x];
  return !!cell && !cell.wall && !blocked.has(`${x},${y}`);
}

export function zoneAt(x: number, y: number): ZoneId | undefined {
  const cell = CELLS[y]?.[x];
  return cell && !cell.wall ? cell.zone : undefined;
}
