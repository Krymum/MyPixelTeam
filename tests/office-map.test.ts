import { describe, expect, it } from "vitest";
import { findPath } from "../src/shared/engine/astar";
import {
  CELLS,
  ENTRANCE,
  FURNITURE,
  isWalkable,
  MAP_H,
  MAP_W,
  SEATS,
  ZONES,
  zoneAt,
} from "../src/shared/engine/office-map";
import { chooseSpot, spotKey } from "../src/shared/engine/placement";

describe("office map", () => {
  it("has the declared size and a closed outer wall except the entrance", () => {
    expect(CELLS).toHaveLength(MAP_H);
    for (const row of CELLS) expect(row).toHaveLength(MAP_W);
    for (let x = 0; x < MAP_W; x++) expect(CELLS[0]![x]!.wall).toBe(true);
    for (let y = 0; y < MAP_H; y++) {
      expect(CELLS[y]![0]!.wall).toBe(true);
      expect(CELLS[y]![MAP_W - 1]!.wall).toBe(true);
    }
  });

  it("keeps furniture on floor tiles", () => {
    for (const f of FURNITURE) {
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(CELLS[y]![x]!.wall, `${f.kind} at ${x},${y}`).toBe(false);
        }
      }
    }
  });

  it("puts every seat on a walkable tile of its zone, reachable from the entrance", () => {
    expect(isWalkable(ENTRANCE.x, ENTRANCE.y)).toBe(true);
    for (const s of SEATS) {
      expect(isWalkable(s.x, s.y), s.id).toBe(true);
      expect(zoneAt(s.x, s.y), s.id).toBe(s.zone);
      expect(findPath(ENTRANCE, s, isWalkable), `path to ${s.id}`).toBeDefined();
    }
  });

  it("has at least six desks in each work room", () => {
    for (const zone of ["dev", "qa", "ops", "research"] as const) {
      expect(SEATS.filter((s) => s.zone === zone && s.sit).length).toBeGreaterThanOrEqual(6);
    }
    expect(Object.keys(ZONES)).toContain("kitchen");
  });
});

describe("findPath", () => {
  const open = () => true;

  it("returns [] when already at the goal and undefined when blocked", () => {
    expect(findPath({ x: 1, y: 1 }, { x: 1, y: 1 }, open)).toEqual([]);
    expect(findPath({ x: 1, y: 1 }, { x: 3, y: 1 }, (x) => x !== 3)).toBeUndefined();
  });

  it("finds a shortest 4-connected path around obstacles", () => {
    // Wall at x=2 except y=3.
    const walkable = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < 5 && y < 5 && (x !== 2 || y === 3);
    const path = findPath({ x: 0, y: 0 }, { x: 4, y: 0 }, walkable)!;
    expect(path.at(-1)).toEqual({ x: 4, y: 0 });
    expect(path).toHaveLength(10);
    path.forEach((p) => expect(walkable(p.x, p.y)).toBe(true));
  });
});

describe("chooseSpot", () => {
  it("hands out distinct seats, then falls back to free floor", () => {
    const taken = new Set<string>();
    const deskCount = SEATS.filter((s) => s.zone === "qa").length;
    for (let i = 0; i < deskCount + 3; i++) {
      const spot = chooseSpot("qa", taken)!;
      expect(taken.has(spotKey(spot))).toBe(false);
      expect(isWalkable(spot.x, spot.y)).toBe(true);
      expect(spot.seatId !== undefined).toBe(i < deskCount);
      taken.add(spotKey(spot));
    }
  });
});
