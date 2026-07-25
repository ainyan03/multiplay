// Movement inside the arena. Players keep the lobby's continuous, momentum
// driven feel rather than snapping cell to cell, so the walls have to be
// resolved as circles against square cells.

import { CELL, cellAt, cellCenterX, cellCenterY, cellIndex, isBlocked, type ArenaSnapshot } from "./arena.ts";

export const ARENA_PLAYER_RADIUS = 14;
/** How far off a corridor's centre line a player is still nudged into it. */
const CORNER_ASSIST = 13;
const ASSIST_SPEED = 210;

type Movable = { x: number; y: number; vx: number; vy: number };

/**
 * Pushes a circle out of any solid cell it overlaps. Resolving the shallowest
 * overlap first keeps a player sliding along a wall instead of catching on the
 * seam between two cells.
 */
export function resolveArenaCollision(body: Movable, arena: ArenaSnapshot, radius = ARENA_PLAYER_RADIUS) {
  for (let pass = 0; pass < 2; pass += 1) {
    const here = cellAt(body.x, body.y);
    let bestOverlap = 0;
    let bestX = 0;
    let bestY = 0;
    for (let row = here.row - 1; row <= here.row + 1; row += 1) {
      for (let col = here.col - 1; col <= here.col + 1; col += 1) {
        if (!isBlocked(arena, col, row)) continue;
        const left = cellCenterX(col) - CELL / 2;
        const top = cellCenterY(row) - CELL / 2;
        const nearestX = Math.min(Math.max(body.x, left), left + CELL);
        const nearestY = Math.min(Math.max(body.y, top), top + CELL);
        const deltaX = body.x - nearestX;
        const deltaY = body.y - nearestY;
        const distance = Math.hypot(deltaX, deltaY);
        const overlap = radius - distance;
        if (overlap <= 0 || overlap <= bestOverlap) continue;
        bestOverlap = overlap;
        if (distance > 0.001) {
          bestX = deltaX / distance;
          bestY = deltaY / distance;
        } else {
          // Dead centre in a cell that just grew back: leave along the axis
          // with the most room rather than picking a direction arbitrarily.
          const awayX = body.x - cellCenterX(col);
          const awayY = body.y - cellCenterY(row);
          const useX = Math.abs(awayX) >= Math.abs(awayY);
          bestX = useX ? Math.sign(awayX) || 1 : 0;
          bestY = useX ? 0 : Math.sign(awayY) || 1;
        }
      }
    }
    if (bestOverlap <= 0) break;
    body.x += bestX * bestOverlap;
    body.y += bestY * bestOverlap;
    // Kill only the velocity heading into the wall; sliding along it survives.
    const into = body.vx * bestX + body.vy * bestY;
    if (into < 0) {
      body.vx -= bestX * into;
      body.vy -= bestY * into;
    }
  }
}

/**
 * Slides a player toward the centre line of the corridor they are entering.
 * Without it, aiming for a gap while slightly off-centre just scrapes the
 * corner and stops, which is the single most annoying thing in a grid arena.
 */
export function applyCornerAssist(body: Movable, arena: ArenaSnapshot, dirX: number, dirY: number, dt: number) {
  const here = cellAt(body.x, body.y);
  if (dirX !== 0 && dirY === 0) {
    const ahead = Math.sign(dirX);
    if (isBlocked(arena, here.col + ahead, here.row)) return;
    const centre = cellCenterY(here.row);
    const offset = centre - body.y;
    if (Math.abs(offset) > 0.5 && Math.abs(offset) < CORNER_ASSIST) {
      body.y += Math.sign(offset) * Math.min(Math.abs(offset), ASSIST_SPEED * dt);
    }
  } else if (dirY !== 0 && dirX === 0) {
    const ahead = Math.sign(dirY);
    if (isBlocked(arena, here.col, here.row + ahead)) return;
    const centre = cellCenterX(here.col);
    const offset = centre - body.x;
    if (Math.abs(offset) > 0.5 && Math.abs(offset) < CORNER_ASSIST) {
      body.x += Math.sign(offset) * Math.min(Math.abs(offset), ASSIST_SPEED * dt);
    }
  }
}

/** Whether a point sits in a burning cell -- the arena's only lethal state. */
export function isInBlast(arena: ArenaSnapshot, x: number, y: number) {
  const cell = cellAt(x, y);
  return arena.blasts.has(cellIndex(cell.col, cell.row));
}
