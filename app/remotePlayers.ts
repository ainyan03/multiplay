import { GAME_HEIGHT, GAME_WIDTH, PLAYER_NAME_LIMIT, type PlayerState } from "./games.ts";

export type WirePlayer = Omit<PlayerState, "seen"> & { seen?: number };
export type RemoteMotion = { x: number; y: number; vx: number; vy: number; receivedAt: number };

const MAX_WIRE_SPEED = 1_000;
const COLOR_PATTERN = /^#[0-9a-f]{3,8}$/i;
const FALLBACK_COLOR = "#8fa3bd";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function finiteOr(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function sanitizeWirePlayer(value: unknown): WirePlayer | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<WirePlayer>;
  if (typeof item.x !== "number" || !Number.isFinite(item.x)) return null;
  if (typeof item.y !== "number" || !Number.isFinite(item.y)) return null;
  return {
    id: typeof item.id === "string" ? item.id.slice(0, 64) : "",
    name: typeof item.name === "string" ? item.name.slice(0, PLAYER_NAME_LIMIT) : "",
    x: clamp(item.x, 0, GAME_WIDTH),
    y: clamp(item.y, 0, GAME_HEIGHT),
    vx: clamp(finiteOr(item.vx, 0), -MAX_WIRE_SPEED, MAX_WIRE_SPEED),
    vy: clamp(finiteOr(item.vy, 0), -MAX_WIRE_SPEED, MAX_WIRE_SPEED),
    color: typeof item.color === "string" && COLOR_PATTERN.test(item.color) ? item.color : FALLBACK_COLOR,
    score: Math.max(0, finiteOr(item.score, 0)),
    crown: item.crown === true,
  };
}

export function receiveRemotePlayer(
  players: Map<string, PlayerState>,
  motions: Map<string, RemoteMotion>,
  state: unknown,
  peerId: string,
  receivedAt: number,
) {
  const sanitized = sanitizeWirePlayer(state);
  if (!sanitized) return;
  const existing = players.get(peerId);
  if (existing) {
    existing.name = sanitized.name;
    existing.color = sanitized.color;
    existing.score = sanitized.score;
    existing.crown = sanitized.crown;
    existing.seen = receivedAt;
  } else {
    players.set(peerId, { ...sanitized, id: peerId, seen: receivedAt });
  }
  motions.set(peerId, { x: sanitized.x, y: sanitized.y, vx: sanitized.vx, vy: sanitized.vy, receivedAt });
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
