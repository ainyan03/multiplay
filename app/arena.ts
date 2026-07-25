// Deterministic arena state. Only bomb placements travel over the wire; every
// client derives the explosions, the chain reactions, the broken blocks and
// their regrowth from that same list, so the field agrees everywhere without
// any of it being synchronised.

import { mulberry32 } from "./rng.ts";

export const CELL = 40;
export const COLS = 23;
export const ROWS = 13;
export const ARENA_LEFT = 20;
export const ARENA_TOP = 10;

export const FUSE_MS = 2_400;
export const BLAST_MS = 460;
export const REGROW_MS = 14_000;
export const BLAST_RANGE = 2;
export const ARENA_SEED = 0x5f3a19;
/** Dense enough to need digging, open enough to keep escape routes. */
export const SOFT_BLOCK_DENSITY = 0.45;
/** Bombs older than this no longer affect the present, so they can be dropped. */
export const BOMB_HORIZON_MS = FUSE_MS + REGROW_MS + BLAST_MS;

export type Cell = { col: number; row: number };
export type BombEvent = { id: string; owner: string; col: number; row: number; at: number };
export type Detonation = BombEvent & { firedAt: number };
export type BlastCell = { col: number; row: number; firedAt: number };

export type ArenaSnapshot = {
  /** Cells holding a standing soft block right now. */
  softBlocks: Set<number>;
  /** Cells currently on fire. */
  blasts: Map<number, BlastCell>;
  /** Bombs placed but not yet detonated. */
  liveBombs: Detonation[];
  /** Every detonation, with the moment it actually went off. */
  detonations: Detonation[];
  /** How many soft blocks each detonation broke, keyed by bomb id. */
  brokenCounts: Map<string, number>;
};

export function cellIndex(col: number, row: number) {
  return row * COLS + col;
}

export function cellCenterX(col: number) {
  return ARENA_LEFT + col * CELL + CELL / 2;
}

export function cellCenterY(row: number) {
  return ARENA_TOP + row * CELL + CELL / 2;
}

export function cellAt(x: number, y: number): Cell {
  return {
    col: Math.floor((x - ARENA_LEFT) / CELL),
    row: Math.floor((y - ARENA_TOP) / CELL),
  };
}

export function isInside(col: number, row: number) {
  return col >= 0 && col < COLS && row >= 0 && row < ROWS;
}

/** The border and the lattice of pillars: permanent, never destructible. */
export function isHardWall(col: number, row: number) {
  if (!isInside(col, row)) return true;
  if (col === 0 || row === 0 || col === COLS - 1 || row === ROWS - 1) return true;
  return col % 2 === 0 && row % 2 === 0;
}

export const SPAWN_CELLS: Cell[] = [
  { col: 1, row: 1 },
  { col: COLS - 2, row: 1 },
  { col: 1, row: ROWS - 2 },
  { col: COLS - 2, row: ROWS - 2 },
  { col: (COLS - 1) >> 1, row: (ROWS - 1) >> 1 },
];

/** Spawns and their immediate neighbours stay clear so nobody starts boxed in. */
function isSpawnPocket(col: number, row: number) {
  return SPAWN_CELLS.some((spawn) => Math.abs(spawn.col - col) + Math.abs(spawn.row - row) <= 1);
}

const MIDDLE_COL = (COLS - 1) >> 1;

/**
 * A ring around the edge plus the middle column, always free of soft blocks.
 * Without it a random layout can seal a spawn behind one block, which in a game
 * with no rounds and regrowing blocks means being stuck for good. The ring also
 * guarantees somewhere to retreat to after dropping a bomb. Both lie on odd
 * rows and columns, where the pillar lattice never intrudes.
 */
function isCorridor(col: number, row: number) {
  if (row === 1 || row === ROWS - 2) return col >= 1 && col <= COLS - 2;
  if (col === 1 || col === COLS - 2) return row >= 1 && row <= ROWS - 2;
  return col === MIDDLE_COL && row >= 1 && row <= ROWS - 2;
}

/** Soft blocks come from a fixed seed, so every client lays out the same maze. */
export function buildSoftBlocks(seed = ARENA_SEED) {
  const random = mulberry32(seed);
  const blocks = new Set<number>();
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      // Draw for every cell so the layout does not shift when a rule changes.
      const roll = random();
      if (isHardWall(col, row) || isSpawnPocket(col, row) || isCorridor(col, row)) continue;
      if (roll < SOFT_BLOCK_DENSITY) blocks.add(cellIndex(col, row));
    }
  }
  return blocks;
}

const DIRECTIONS = [
  { col: 1, row: 0 },
  { col: -1, row: 0 },
  { col: 0, row: 1 },
  { col: 0, row: -1 },
];

/**
 * Replays the bomb list as an event simulation. Bombs fire in time order; each
 * blast clears the soft blocks it reaches and sets off any bomb it covers. The
 * ordering is fixed -- earliest fuse first, ties broken by id -- so every client
 * walks the same sequence and ends with the same field.
 */
export function arenaAt(bombs: BombEvent[], now: number, seed = ARENA_SEED, range = BLAST_RANGE): ArenaSnapshot {
  const original = buildSoftBlocks(seed);
  const brokenAt = new Map<number, number>();
  const scheduled = new Map<string, number>();
  const byCell = new Map<number, BombEvent[]>();

  const ordered = [...bombs].sort((first, second) => first.at - second.at || first.id.localeCompare(second.id));
  for (const bomb of ordered) {
    scheduled.set(bomb.id, bomb.at + FUSE_MS);
    const key = cellIndex(bomb.col, bomb.row);
    const list = byCell.get(key);
    if (list) list.push(bomb); else byCell.set(key, [bomb]);
  }

  const standing = (col: number, row: number, time: number) => {
    const key = cellIndex(col, row);
    if (!original.has(key)) return false;
    const broken = brokenAt.get(key);
    return broken === undefined || time >= broken + REGROW_MS;
  };

  const pending = new Set(ordered.map((bomb) => bomb.id));
  const byId = new Map(ordered.map((bomb) => [bomb.id, bomb]));
  const detonations: Detonation[] = [];
  const brokenCounts = new Map<string, number>();

  while (pending.size) {
    let next: BombEvent | null = null;
    for (const id of pending) {
      const bomb = byId.get(id)!;
      const time = scheduled.get(id)!;
      const bestTime = next ? scheduled.get(next.id)! : Infinity;
      if (time < bestTime || (time === bestTime && next && bomb.id < next.id)) next = bomb;
    }
    if (!next) break;
    const firedAt = scheduled.get(next.id)!;
    pending.delete(next.id);
    detonations.push({ ...next, firedAt });

    for (const direction of DIRECTIONS) {
      for (let step = 1; step <= range; step += 1) {
        const col = next.col + direction.col * step;
        const row = next.row + direction.row * step;
        if (isHardWall(col, row)) break;
        for (const other of byCell.get(cellIndex(col, row)) ?? []) {
          // Only a bomb already on the ground can be set off by this blast.
          if (!pending.has(other.id) || other.at > firedAt) continue;
          if (scheduled.get(other.id)! > firedAt) scheduled.set(other.id, firedAt);
        }
        if (standing(col, row, firedAt)) {
          brokenAt.set(cellIndex(col, row), firedAt);
          brokenCounts.set(next.id, (brokenCounts.get(next.id) ?? 0) + 1);
          break;
        }
      }
    }
  }

  const softBlocks = new Set<number>();
  for (const key of original) {
    const broken = brokenAt.get(key);
    // The walk above runs every bomb, including ones whose fuse has not burned
    // down yet, so a break can be scheduled ahead of `now`. Until that moment
    // arrives the block is still standing -- otherwise it would vanish as soon
    // as the bomb was placed.
    const standingNow = broken === undefined || broken > now || now >= broken + REGROW_MS;
    if (standingNow) softBlocks.add(key);
  }

  const blasts = new Map<number, BlastCell>();
  const liveBombs: Detonation[] = [];
  for (const bomb of detonations) {
    if (bomb.firedAt > now) { liveBombs.push(bomb); continue; }
    if (now >= bomb.firedAt + BLAST_MS) continue;
    markBlast(blasts, bomb.col, bomb.row, bomb.firedAt);
    for (const direction of DIRECTIONS) {
      for (let step = 1; step <= range; step += 1) {
        const col = bomb.col + direction.col * step;
        const row = bomb.row + direction.row * step;
        if (isHardWall(col, row)) break;
        markBlast(blasts, col, row, bomb.firedAt);
        // The block this blast broke stopped it, so nothing past it burns.
        if (brokenAt.get(cellIndex(col, row)) === bomb.firedAt) break;
      }
    }
  }

  return { softBlocks, blasts, liveBombs, detonations, brokenCounts };
}

function markBlast(blasts: Map<number, BlastCell>, col: number, row: number, firedAt: number) {
  const key = cellIndex(col, row);
  const existing = blasts.get(key);
  if (!existing || firedAt > existing.firedAt) blasts.set(key, { col, row, firedAt });
}

export function isBlocked(snapshot: ArenaSnapshot, col: number, row: number) {
  return isHardWall(col, row) || snapshot.softBlocks.has(cellIndex(col, row));
}

export function pruneBombs(bombs: BombEvent[], now: number) {
  return bombs.filter((bomb) => bomb.at >= now - BOMB_HORIZON_MS);
}
