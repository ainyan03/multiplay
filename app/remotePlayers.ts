import { GAME_HEIGHT, GAME_WIDTH, PLAYER_NAME_LIMIT, type PlayerState } from "./games.ts";
import { finite, integer, record } from "./validate.ts";

export type WirePlayer = {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  score: number;
  crown?: boolean;
  seq?: number;
  ts?: number;
};

export type RemoteMotion = { x: number; y: number; vx: number; vy: number; receivedAt: number; seq: number };

// Positions leave the field briefly during knockback, so the accepted box is the
// field plus a margin rather than the field itself.
const POSITION_MARGIN = 64;
const MAX_WIRE_SPEED = 2_000;
const MAX_WIRE_SCORE = 10_000_000;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// A malformed field means the sender is misbehaving, so the whole update is
// dropped. Repairing it instead would let a peer place itself anywhere by
// sending values that get clamped back into the field.
export function sanitizeWirePlayer(value: unknown): WirePlayer | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item.name !== "string" || item.name.length > PLAYER_NAME_LIMIT) return null;
  if (!finite(item.x, -POSITION_MARGIN, GAME_WIDTH + POSITION_MARGIN)) return null;
  if (!finite(item.y, -POSITION_MARGIN, GAME_HEIGHT + POSITION_MARGIN)) return null;
  if (!finite(item.vx, -MAX_WIRE_SPEED, MAX_WIRE_SPEED)) return null;
  if (!finite(item.vy, -MAX_WIRE_SPEED, MAX_WIRE_SPEED)) return null;
  if (typeof item.color !== "string" || !COLOR_PATTERN.test(item.color)) return null;
  if (!finite(item.score, 0, MAX_WIRE_SCORE)) return null;
  if (item.crown !== undefined && typeof item.crown !== "boolean") return null;
  // Older builds predate these fields; those updates stay accepted without them.
  if (item.seq !== undefined && !integer(item.seq, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (item.ts !== undefined && !finite(item.ts, 0, Number.MAX_SAFE_INTEGER)) return null;
  return {
    name: item.name,
    x: item.x,
    y: item.y,
    vx: item.vx,
    vy: item.vy,
    color: item.color,
    score: item.score,
    ...(item.crown === undefined ? {} : { crown: item.crown }),
    ...(item.seq === undefined ? {} : { seq: item.seq }),
    ...(item.ts === undefined ? {} : { ts: item.ts }),
  };
}

export function toWirePlayer(player: PlayerState, seq: number, ts: number): WirePlayer {
  return {
    name: player.name,
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    color: player.color,
    score: player.score,
    ...(player.crown === undefined ? {} : { crown: player.crown }),
    seq,
    ts,
  };
}

export function receiveRemotePlayer(
  players: Map<string, PlayerState>,
  motions: Map<string, RemoteMotion>,
  state: unknown,
  peerId: string,
  receivedAt: number,
): WirePlayer | null {
  const sanitized = sanitizeWirePlayer(state);
  if (!sanitized) return null;
  const previous = motions.get(peerId);
  // A late packet would otherwise rewind the remote avatar by less than the
  // teleport threshold, which reads as stutter rather than an obvious fault.
  if (sanitized.seq !== undefined && previous && sanitized.seq <= previous.seq) return null;
  const existing = players.get(peerId);
  if (existing) {
    existing.name = sanitized.name;
    existing.color = sanitized.color;
    existing.score = sanitized.score;
    existing.crown = sanitized.crown;
    existing.seen = receivedAt;
  } else {
    players.set(peerId, { ...sanitized, id: peerId, crown: sanitized.crown, seen: receivedAt });
  }
  motions.set(peerId, {
    x: sanitized.x,
    y: sanitized.y,
    vx: sanitized.vx,
    vy: sanitized.vy,
    receivedAt,
    seq: sanitized.seq ?? (previous ? previous.seq : 0),
  });
  return sanitized;
}

export function smoothRemotePlayers(
  players: Map<string, PlayerState>,
  motions: Map<string, RemoteMotion>,
  selfId: string,
  dt: number,
  now: number,
) {
  const blend = 1 - Math.exp(-11 * dt);
  for (const [id, motion] of motions) {
    const player = players.get(id);
    if (!player || id === selfId) continue;
    const prediction = Math.min((now - motion.receivedAt) / 1000, .22);
    const targetX = motion.x + motion.vx * prediction;
    const targetY = motion.y + motion.vy * prediction;
    if (Math.hypot(targetX - player.x, targetY - player.y) > 220) {
      player.x = targetX; player.y = targetY;
    } else {
      player.x += (targetX - player.x) * blend;
      player.y += (targetY - player.y) * blend;
    }
    player.vx += (motion.vx - player.vx) * blend;
    player.vy += (motion.vy - player.vy) * blend;
  }
}
