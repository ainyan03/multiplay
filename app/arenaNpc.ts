// Enemies without a host. Every client owns a fixed slice of them, named
// `<peerId>:npc:<slot>`, and only the owner decides how its own enemies move or
// die. Nobody has to agree on anything: the id says whose word counts, and when
// an owner leaves its enemies simply go with it.

import { CELL, cellAt, cellCenterX, cellCenterY, isBlocked, type ArenaSnapshot } from "./arena.ts";
import { isInBlast } from "./arenaMotion.ts";
import { hashString, mulberry32 } from "./rng.ts";
import { boundedString, finite, integer, record } from "./validate.ts";

export const NPCS_PER_PEER = 3;
export const NPC_RADIUS = 13;
export const NPC_SPEED = 78;
export const NPC_RESPAWN_MS = 6_000;
const NPC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}:npc:[0-9]$/;

export type Npc = {
  id: string;
  x: number;
  y: number;
  dirCol: number;
  dirRow: number;
  alive: boolean;
  respawnAt: number;
};

export type WireNpc = { id: string; x: number; y: number; alive: boolean };
export type NpcSnapshot = { npcs: WireNpc[]; ts: number };
export type RemoteNpc = WireNpc & { renderX: number; renderY: number; seenAt: number };

export function npcId(peerId: string, slot: number) {
  return `${peerId}:npc:${slot}`;
}

export function npcOwner(id: string) {
  const marker = id.indexOf(":npc:");
  return marker < 0 ? null : id.slice(0, marker);
}

const DIRECTIONS = [
  { col: 1, row: 0 },
  { col: -1, row: 0 },
  { col: 0, row: 1 },
  { col: 0, row: -1 },
];

/** Spawns land on open cells picked from the enemy's own id, so they scatter. */
export function spawnNpc(id: string, arena: ArenaSnapshot, now: number): Npc {
  const random = mulberry32(hashString(id) ^ Math.floor(now / 1000));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const col = 1 + Math.floor(random() * 21);
    const row = 1 + Math.floor(random() * 11);
    if (isBlocked(arena, col, row)) continue;
    return {
      id,
      x: cellCenterX(col),
      y: cellCenterY(row),
      dirCol: 0,
      dirRow: 0,
      alive: true,
      respawnAt: 0,
    };
  }
  return { id, x: cellCenterX(11), y: cellCenterY(6), dirCol: 0, dirRow: 0, alive: true, respawnAt: 0 };
}

/**
 * Walks cell to cell, turning only once it reaches a centre. Enemies drift
 * toward the nearest player but refuse to step into fire, which is what makes
 * luring one into a blast feel deliberate rather than lucky.
 */
export function updateNpc(
  npc: Npc,
  arena: ArenaSnapshot,
  targets: Array<{ x: number; y: number }>,
  dt: number,
  now: number,
) {
  if (!npc.alive) {
    if (now >= npc.respawnAt) {
      const fresh = spawnNpc(npc.id, arena, now);
      npc.x = fresh.x; npc.y = fresh.y;
      npc.dirCol = 0; npc.dirRow = 0;
      npc.alive = true;
    }
    return;
  }

  if (isInBlast(arena, npc.x, npc.y)) {
    npc.alive = false;
    npc.respawnAt = now + NPC_RESPAWN_MS;
    return;
  }

  const here = cellAt(npc.x, npc.y);
  const centreX = cellCenterX(here.col);
  const centreY = cellCenterY(here.row);
  const atCentre = Math.hypot(npc.x - centreX, npc.y - centreY) < 2;

  if (atCentre || (npc.dirCol === 0 && npc.dirRow === 0)) {
    npc.x = centreX;
    npc.y = centreY;
    const choice = chooseDirection(npc, arena, here, targets, now);
    npc.dirCol = choice.col;
    npc.dirRow = choice.row;
  }

  const nextCol = here.col + npc.dirCol;
  const nextRow = here.row + npc.dirRow;
  if ((npc.dirCol || npc.dirRow) && isBlocked(arena, nextCol, nextRow)) {
    npc.x = centreX;
    npc.y = centreY;
    npc.dirCol = 0;
    npc.dirRow = 0;
    return;
  }
  npc.x += npc.dirCol * NPC_SPEED * dt;
  npc.y += npc.dirRow * NPC_SPEED * dt;
}

function chooseDirection(
  npc: Npc,
  arena: ArenaSnapshot,
  here: { col: number; row: number },
  targets: Array<{ x: number; y: number }>,
  now: number,
) {
  const open = DIRECTIONS.filter((direction) => {
    const col = here.col + direction.col;
    const row = here.row + direction.row;
    if (isBlocked(arena, col, row)) return false;
    return !isInBlast(arena, cellCenterX(col), cellCenterY(row));
  });
  if (!open.length) return { col: 0, row: 0 };

  const random = mulberry32(hashString(npc.id) + Math.floor(now / 250));
  // Mostly chase, sometimes wander, so enemies stay unpredictable in a corridor.
  const nearest = nearestTarget(npc, targets);
  if (nearest && random() < 0.75) {
    const wantCol = Math.sign(nearest.x - npc.x);
    const wantRow = Math.sign(nearest.y - npc.y);
    const preferred = open.filter((direction) =>
      (direction.col !== 0 && direction.col === wantCol) || (direction.row !== 0 && direction.row === wantRow));
    if (preferred.length) return preferred[Math.floor(random() * preferred.length)]!;
  }
  return open[Math.floor(random() * open.length)]!;
}

function nearestTarget(npc: Npc, targets: Array<{ x: number; y: number }>) {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = Math.hypot(target.x - npc.x, target.y - npc.y);
    if (distance < bestDistance) { bestDistance = distance; best = target; }
  }
  return bestDistance < CELL * 9 ? best : null;
}

export function toWireNpcs(npcs: Map<string, Npc>): WireNpc[] {
  return [...npcs.values()].map((npc) => ({
    id: npc.id,
    x: Math.round(npc.x),
    y: Math.round(npc.y),
    alive: npc.alive,
  }));
}

/** An owner may only speak for its own enemies, which the id makes checkable. */
export function sanitizeNpcSnapshot(value: unknown, peerId: string): WireNpc[] | null {
  const item = record(value);
  if (!item || !Array.isArray(item.npcs)) return null;
  if (item.npcs.length > NPCS_PER_PEER) return null;
  if (!finite(item.ts, 0, Number.MAX_SAFE_INTEGER)) return null;
  const result: WireNpc[] = [];
  for (const entry of item.npcs) {
    const npc = record(entry);
    if (!npc) return null;
    if (!boundedString(npc.id, 80) || !NPC_ID_PATTERN.test(npc.id)) return null;
    if (npcOwner(npc.id) !== peerId) return null;
    if (!integer(npc.x, -200, 2_000) || !integer(npc.y, -200, 2_000)) return null;
    if (typeof npc.alive !== "boolean") return null;
    result.push({ id: npc.id, x: npc.x, y: npc.y, alive: npc.alive });
  }
  return result;
}

/** Remote enemies arrive a few times a second, so their drawn position eases. */
export function blendRemoteNpcs(remotes: Map<string, RemoteNpc>, dt: number) {
  const blend = 1 - Math.exp(-9 * dt);
  for (const npc of remotes.values()) {
    npc.renderX += (npc.x - npc.renderX) * blend;
    npc.renderY += (npc.y - npc.renderY) * blend;
  }
}

export function receiveNpcSnapshot(
  remotes: Map<string, RemoteNpc>,
  wire: WireNpc[],
  peerId: string,
  receivedAt: number,
) {
  const seen = new Set<string>();
  for (const npc of wire) {
    seen.add(npc.id);
    const existing = remotes.get(npc.id);
    if (existing) {
      existing.x = npc.x;
      existing.y = npc.y;
      existing.alive = npc.alive;
      existing.seenAt = receivedAt;
    } else {
      remotes.set(npc.id, { ...npc, renderX: npc.x, renderY: npc.y, seenAt: receivedAt });
    }
  }
  // An enemy the owner stopped reporting no longer exists.
  for (const [id, npc] of remotes) {
    if (npcOwner(id) === peerId && !seen.has(id)) remotes.delete(id);
    else if (receivedAt - npc.seenAt > 12_000) remotes.delete(id);
  }
}

export function dropNpcsOwnedBy(remotes: Map<string, RemoteNpc>, peerId: string) {
  for (const id of [...remotes.keys()]) if (npcOwner(id) === peerId) remotes.delete(id);
}
