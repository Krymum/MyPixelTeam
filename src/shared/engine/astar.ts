export interface Point {
  x: number;
  y: number;
}

/**
 * A* on a 4-connected grid. Returns the tiles from start (exclusive) to goal (inclusive),
 * [] when already there, or undefined when the goal is unreachable.
 */
export function findPath(
  start: Point,
  goal: Point,
  walkable: (x: number, y: number) => boolean,
  maxNodes = 5000,
): Point[] | undefined {
  if (start.x === goal.x && start.y === goal.y) return [];
  if (!walkable(goal.x, goal.y)) return undefined;

  const key = (p: Point) => `${p.x},${p.y}`;
  const h = (p: Point) => Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y);
  const open: { p: Point; f: number; g: number }[] = [{ p: start, f: h(start), g: 0 }];
  const cameFrom = new Map<string, Point>();
  const best = new Map<string, number>([[key(start), 0]]);
  let expanded = 0;

  while (open.length && expanded++ < maxNodes) {
    // Small grids: a linear scan beats maintaining a heap.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[bi]!.f) bi = i;
    const { p, g } = open.splice(bi, 1)[0]!;
    if (p.x === goal.x && p.y === goal.y) {
      const path: Point[] = [];
      for (
        let cur: Point | undefined = p;
        cur && key(cur) !== key(start);
        cur = cameFrom.get(key(cur))
      ) {
        path.unshift(cur);
      }
      return path;
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (!walkable(n.x, n.y)) continue;
      const ng = g + 1;
      if (ng >= (best.get(key(n)) ?? Infinity)) continue;
      best.set(key(n), ng);
      cameFrom.set(key(n), p);
      open.push({ p: n, g: ng, f: ng + h(n) });
    }
  }
  return undefined;
}
