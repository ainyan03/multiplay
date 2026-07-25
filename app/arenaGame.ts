// The arena game loop, kept out of the screen component because it runs a
// different simulation from the free-floating games: a shared clock, walls, and
// a bomb list that everyone replays rather than syncs.

import {
  ARENA_LEFT,
  ARENA_TOP,
  arenaAt,
  BLAST_MS,
  CELL,
  cellAt,
  cellCenterX,
  cellCenterY,
  cellIndex,
  COLS,
  FUSE_MS,
  isHardWall,
  pruneBombs,
  ROWS,
  SPAWN_CELLS,
  type ArenaSnapshot,
  type BombEvent,
} from "./arena.ts";
import { applyCornerAssist, ARENA_PLAYER_RADIUS, isInBlast, resolveArenaCollision } from "./arenaMotion.ts";
import {
  blendRemoteNpcs,
  npcId,
  NPC_RADIUS,
  NPCS_PER_PEER,
  spawnNpc,
  updateNpc,
  type Npc,
  type RemoteNpc,
} from "./arenaNpc.ts";
import { type PlayerState } from "./games.ts";
import { boundedString, finite, integer, record } from "./validate.ts";

export const ARENA_MOVE_SPEED = 190;
export const MAX_LIVE_BOMBS = 2;
export const DEATH_MS = 1_800;
const BOMB_COOLDOWN_MS = 260;
const BLOCK_SCORE = 1;
const KILL_SCORE = 3;
const DEATH_PENALTY = 2;

export type ArenaRuntime = {
  bombs: BombEvent[];
  bombIds: Set<string>;
  npcs: Map<string, Npc>;
  remoteNpcs: Map<string, RemoteNpc>;
  deadUntil: number;
  lastBombAt: number;
  /** Detonations already scored, so a blast is only counted once. */
  scored: Set<string>;
  npcAlive: Map<string, boolean>;
};

export function createArenaRuntime(): ArenaRuntime {
  return {
    bombs: [],
    bombIds: new Set(),
    npcs: new Map(),
    remoteNpcs: new Map(),
    deadUntil: 0,
    lastBombAt: 0,
    scored: new Set(),
    npcAlive: new Map(),
  };
}

export function sanitizeBombEvent(value: unknown, peerId: string, roomNow: number): BombEvent | null {
  const item = record(value);
  if (!item) return null;
  if (!boundedString(item.id, 160)) return null;
  if (!integer(item.col, 0, COLS - 1) || !integer(item.row, 0, ROWS - 1)) return null;
  if (isHardWall(item.col, item.row)) return null;
  // A bomb far outside the fuse window could rewrite the past, so it is refused.
  if (!finite(item.at, roomNow - FUSE_MS * 4, roomNow + FUSE_MS)) return null;
  // Ownership follows the transport, never the payload.
  return { id: item.id, owner: peerId, col: item.col, row: item.row, at: item.at };
}

export function addBomb(runtime: ArenaRuntime, bomb: BombEvent) {
  if (runtime.bombIds.has(bomb.id)) return false;
  runtime.bombIds.add(bomb.id);
  runtime.bombs.push(bomb);
  return true;
}

export function ownedNpcIds(selfId: string) {
  return Array.from({ length: NPCS_PER_PEER }, (_, slot) => npcId(selfId, slot));
}

/** Where a player reappears: the spawn furthest from any current danger. */
export function safeSpawn(arena: ArenaSnapshot, avoid: Array<{ x: number; y: number }>) {
  let best = SPAWN_CELLS[0]!;
  let bestScore = -Infinity;
  for (const spawn of SPAWN_CELLS) {
    const x = cellCenterX(spawn.col);
    const y = cellCenterY(spawn.row);
    if (isInBlast(arena, x, y)) continue;
    let nearest = Infinity;
    for (const other of avoid) nearest = Math.min(nearest, Math.hypot(other.x - x, other.y - y));
    if (nearest > bestScore) { bestScore = nearest; best = spawn; }
  }
  return { x: cellCenterX(best.col), y: cellCenterY(best.row) };
}

export type ArenaStepInput = {
  runtime: ArenaRuntime;
  me: PlayerState;
  players: Map<string, PlayerState>;
  selfId: string;
  dirX: number;
  dirY: number;
  dt: number;
  roomNow: number;
  playTone: (frequency: number) => void;
};

export function stepArena({ runtime, me, players, selfId, dirX, dirY, dt, roomNow, playTone }: ArenaStepInput) {
  runtime.bombs = pruneBombs(runtime.bombs, roomNow);
  const arena = arenaAt(runtime.bombs, roomNow);

  scoreOwnBlasts(runtime, me, selfId, arena, roomNow, playTone);

  const dead = roomNow < runtime.deadUntil;
  if (!dead) {
    me.vx += (dirX * ARENA_MOVE_SPEED - me.vx) * Math.min(dt * 12, 1);
    me.vy += (dirY * ARENA_MOVE_SPEED - me.vy) * Math.min(dt * 12, 1);
    if (!dirX) me.vx *= Math.pow(.005, dt);
    if (!dirY) me.vy *= Math.pow(.005, dt);
    applyCornerAssist(me, arena, dirX, dirY, dt);
    me.x += me.vx * dt;
    me.y += me.vy * dt;
    resolveArenaCollision(me, arena);
  } else {
    me.vx = 0;
    me.vy = 0;
  }

  updateOwnedNpcs(runtime, arena, players, selfId, dt, roomNow);

  if (!dead && (isInBlast(arena, me.x, me.y) || touchingEnemy(runtime, me))) {
    runtime.deadUntil = roomNow + DEATH_MS;
    me.score = Math.max(0, me.score - DEATH_PENALTY);
    playTone(90);
  }
  if (dead && roomNow >= runtime.deadUntil - dt * 1000) {
    const spot = safeSpawn(arena, [...players.values()].filter((player) => player.id !== selfId));
    me.x = spot.x;
    me.y = spot.y;
  }

  return arena;
}

/** Blocks broken and enemies caught by our own bombs, counted once each. */
function scoreOwnBlasts(
  runtime: ArenaRuntime,
  me: PlayerState,
  selfId: string,
  arena: ArenaSnapshot,
  roomNow: number,
  playTone: (frequency: number) => void,
) {
  for (const detonation of arena.detonations) {
    if (detonation.owner !== selfId) continue;
    if (detonation.firedAt > roomNow || runtime.scored.has(detonation.id)) continue;
    runtime.scored.add(detonation.id);
    const broken = arena.brokenCounts.get(detonation.id) ?? 0;
    if (broken) me.score += broken * BLOCK_SCORE;
    playTone(320);
  }
  if (runtime.scored.size > 256) {
    const oldest = runtime.scored.values().next().value;
    if (oldest) runtime.scored.delete(oldest);
  }

  for (const npc of runtime.remoteNpcs.values()) {
    const was = runtime.npcAlive.get(npc.id);
    if (was === true && !npc.alive && isInBlast(arena, npc.x, npc.y)) me.score += KILL_SCORE;
    runtime.npcAlive.set(npc.id, npc.alive);
  }
  for (const npc of runtime.npcs.values()) runtime.npcAlive.set(npc.id, npc.alive);
}

function updateOwnedNpcs(
  runtime: ArenaRuntime,
  arena: ArenaSnapshot,
  players: Map<string, PlayerState>,
  selfId: string,
  dt: number,
  roomNow: number,
) {
  for (const id of ownedNpcIds(selfId)) {
    if (!runtime.npcs.has(id)) runtime.npcs.set(id, spawnNpc(id, arena, roomNow));
  }
  const targets = [...players.values()];
  for (const npc of runtime.npcs.values()) updateNpc(npc, arena, targets, dt, roomNow);
  blendRemoteNpcs(runtime.remoteNpcs, dt);
}

function touchingEnemy(runtime: ArenaRuntime, me: PlayerState) {
  const reach = ARENA_PLAYER_RADIUS + NPC_RADIUS - 6;
  for (const npc of runtime.npcs.values()) {
    if (npc.alive && Math.hypot(npc.x - me.x, npc.y - me.y) < reach) return true;
  }
  for (const npc of runtime.remoteNpcs.values()) {
    if (npc.alive && Math.hypot(npc.renderX - me.x, npc.renderY - me.y) < reach) return true;
  }
  return false;
}

/** Returns the bomb to broadcast, or null when placing one is not allowed. */
export function tryPlaceBomb(
  runtime: ArenaRuntime,
  me: PlayerState,
  selfId: string,
  roomNow: number,
): BombEvent | null {
  if (roomNow < runtime.deadUntil) return null;
  if (roomNow - runtime.lastBombAt < BOMB_COOLDOWN_MS) return null;
  const arena = arenaAt(runtime.bombs, roomNow);
  const live = arena.liveBombs.filter((bomb) => bomb.owner === selfId);
  if (live.length >= MAX_LIVE_BOMBS) return null;
  const cell = cellAt(me.x, me.y);
  if (isHardWall(cell.col, cell.row)) return null;
  if (arena.liveBombs.some((bomb) => bomb.col === cell.col && bomb.row === cell.row)) return null;
  runtime.lastBombAt = roomNow;
  return {
    id: `${selfId}:${Math.round(roomNow)}:${cellIndex(cell.col, cell.row)}`,
    owner: selfId,
    col: cell.col,
    row: cell.row,
    at: roomNow,
  };
}

export function drawArena(
  context: CanvasRenderingContext2D,
  arena: ArenaSnapshot,
  runtime: ArenaRuntime,
  roomNow: number,
) {
  context.fillStyle = "#0a1420";
  context.fillRect(0, 0, 960, 540);
  context.fillStyle = "#0e1c2c";
  context.fillRect(ARENA_LEFT, ARENA_TOP, COLS * CELL, ROWS * CELL);

  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const x = ARENA_LEFT + col * CELL;
      const y = ARENA_TOP + row * CELL;
      if (isHardWall(col, row)) {
        context.fillStyle = "#243a54";
        context.fillRect(x, y, CELL, CELL);
        context.fillStyle = "#2f4a69";
        context.fillRect(x + 3, y + 3, CELL - 6, CELL - 10);
      } else if (arena.softBlocks.has(cellIndex(col, row))) {
        context.fillStyle = "#7a5330";
        context.fillRect(x + 2, y + 2, CELL - 4, CELL - 4);
        context.fillStyle = "#96683c";
        context.fillRect(x + 5, y + 5, CELL - 10, CELL - 14);
      }
    }
  }

  for (const bomb of arena.liveBombs) {
    const remaining = bomb.firedAt - roomNow;
    // Tightening pulse as the fuse runs out, so timing a dodge is readable.
    const beat = 1 + Math.sin(roomNow / (remaining < 700 ? 45 : 110)) * .16;
    context.save();
    context.translate(cellCenterX(bomb.col), cellCenterY(bomb.row));
    context.scale(beat, beat);
    context.fillStyle = "#12212f";
    context.beginPath(); context.arc(0, 0, 13, 0, Math.PI * 2); context.fill();
    context.strokeStyle = remaining < 700 ? "#ff6b8a" : "#f9e547";
    context.lineWidth = 3;
    // The ring sits outside the avatar so a bomb you are standing on still shows.
    context.beginPath(); context.arc(0, 0, 19, 0, Math.PI * 2); context.stroke();
    context.restore();
  }

  for (const blast of arena.blasts.values()) {
    const age = (roomNow - blast.firedAt) / BLAST_MS;
    const fade = Math.max(0, 1 - age);
    const x = ARENA_LEFT + blast.col * CELL;
    const y = ARENA_TOP + blast.row * CELL;
    context.fillStyle = `rgba(255,157,77,${.85 * fade})`;
    context.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
    context.fillStyle = `rgba(255,240,200,${.9 * fade})`;
    const inset = 6 + age * 10;
    context.fillRect(x + inset, y + inset, CELL - inset * 2, CELL - inset * 2);
  }

  for (const npc of runtime.npcs.values()) if (npc.alive) drawEnemy(context, npc.x, npc.y, roomNow);
  for (const npc of runtime.remoteNpcs.values()) if (npc.alive) drawEnemy(context, npc.renderX, npc.renderY, roomNow);
}

function drawEnemy(context: CanvasRenderingContext2D, x: number, y: number, roomNow: number) {
  context.save();
  context.translate(x, y);
  context.fillStyle = "#b45cff";
  context.shadowBlur = 14;
  context.shadowColor = "#b45cff";
  context.beginPath();
  context.arc(0, 0, NPC_RADIUS, Math.PI, 0);
  context.lineTo(NPC_RADIUS, NPC_RADIUS - 3);
  const teeth = 4;
  for (let index = teeth - 1; index >= 0; index -= 1) {
    const step = (NPC_RADIUS * 2) / teeth;
    context.lineTo(-NPC_RADIUS + index * step + step / 2, NPC_RADIUS + 2);
    context.lineTo(-NPC_RADIUS + index * step, NPC_RADIUS - 3);
  }
  context.closePath();
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "#1b0a2c";
  const look = Math.sin(roomNow / 400) * 2;
  context.fillRect(-6 + look, -5, 4, 5);
  context.fillRect(3 + look, -5, 4, 5);
  context.restore();
}

export function drawDeathOverlay(context: CanvasRenderingContext2D, remaining: number) {
  context.fillStyle = "rgba(9,17,29,.55)";
  context.fillRect(0, 0, 960, 540);
  context.textAlign = "center";
  context.fillStyle = "#ff6b8a";
  context.font = "900 30px monospace";
  context.fillText("BLASTED", 480, 258);
  context.fillStyle = "#8fa3bd";
  context.font = "700 13px monospace";
  context.fillText(`${Math.ceil(remaining / 1000)} 秒後に復帰`, 480, 286);
}
