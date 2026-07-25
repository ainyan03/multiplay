import { GAME_HEIGHT, GAME_WIDTH, type PlayerState } from "./games.ts";

const PLAYER_RADIUS = 18;
const COLLISION_DISTANCE = PLAYER_RADIUS * 2;
const RESTITUTION = .72;
const MAX_COLLISION_SPEED = 420;
const COLLISION_COOLDOWN_MS = 120;
const LOBBY_MOVE_SPEED = 285;

export type LobbyCollisionImpulse = { targetId: string; vx: number; vy: number };

function fallbackNormal(firstId: string, secondId: string) {
  const ordered = firstId < secondId ? `${firstId}:${secondId}` : `${secondId}:${firstId}`;
  let hash = 2166136261;
  for (let index = 0; index < ordered.length; index += 1) {
    hash ^= ordered.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const angle = (hash >>> 0) / 0xffffffff * Math.PI * 2;
  const direction = firstId < secondId ? 1 : -1;
  return { x: Math.cos(angle) * direction, y: Math.sin(angle) * direction };
}

function limitSpeed(player: PlayerState) {
  const speed = Math.hypot(player.vx, player.vy);
  if (speed <= MAX_COLLISION_SPEED) return;
  const scale = MAX_COLLISION_SPEED / speed;
  player.vx *= scale;
  player.vy *= scale;
}

export function applyLobbyImpulse(me: PlayerState, vx: number, vy: number) {
  me.vx += vx;
  me.vy += vy;
  limitSpeed(me);
}

export function steerLobbyPlayer(me: PlayerState, x: number, y: number, dt: number) {
  const inputLengthSquared = x * x + y * y;
  if (inputLengthSquared > 0) {
    const velocityAlongInput = me.vx * x + me.vy * y;
    if (velocityAlongInput < 0) {
      // Remove only the velocity component opposing fresh input; preserve sideways momentum.
      me.vx -= x * velocityAlongInput / inputLengthSquared;
      me.vy -= y * velocityAlongInput / inputLengthSquared;
    }
  }
  me.vx += (x * LOBBY_MOVE_SPEED - me.vx) * Math.min(dt * 9, 1);
  me.vy += (y * LOBBY_MOVE_SPEED - me.vy) * Math.min(dt * 9, 1);
  if (!x) me.vx *= Math.pow(.01, dt);
  if (!y) me.vy *= Math.pow(.01, dt);
}

export function isLobbyImpulsePlausible(
  me: PlayerState,
  source: PlayerState,
  vx: number,
  vy: number,
  now: number,
) {
  const impulseLength = Math.hypot(vx, vy);
  const deltaX = me.x - source.x;
  const deltaY = me.y - source.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || impulseLength <= 0 || impulseLength > 430) return false;
  if (now - source.seen > 600 || distance <= .001 || distance > COLLISION_DISTANCE + 36) return false;
  const alignment = (vx * deltaX + vy * deltaY) / (impulseLength * distance);
  return alignment >= .45;
}

export function resolveLobbyCollisions(
  me: PlayerState,
  players: Map<string, PlayerState>,
  now: number,
  lastResolved: Map<string, number>,
) {
  const outgoing: LobbyCollisionImpulse[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    for (const other of players.values()) {
      if (other.id === me.id || now - other.seen > 2_000) continue;

      const deltaX = me.x - other.x;
      const deltaY = me.y - other.y;
      const distance = Math.hypot(deltaX, deltaY);
      if (distance >= COLLISION_DISTANCE) continue;

      const normal = distance > .001
        ? { x: deltaX / distance, y: deltaY / distance }
        : fallbackNormal(me.id, other.id);
      const overlap = COLLISION_DISTANCE - distance;

      // Both peers move their own avatar, so each resolves roughly half the overlap.
      const correction = overlap * .52;
      me.x += normal.x * correction;
      me.y += normal.y * correction;

      const inwardSpeed = -(me.vx * normal.x + me.vy * normal.y);
      const relativeNormalSpeed = (me.vx - other.vx) * normal.x + (me.vy - other.vy) * normal.y;
      const canResolve = now - (lastResolved.get(other.id) ?? 0) >= COLLISION_COOLDOWN_MS;
      if (inwardSpeed > 8 && relativeNormalSpeed < -8 && canResolve) {
        // Transfer only this peer's inward momentum. Reversing input removes it before contact.
        applyLobbyImpulse(me, normal.x * inwardSpeed, normal.y * inwardSpeed);
        outgoing.push({
          targetId: other.id,
          vx: -normal.x * inwardSpeed * RESTITUTION,
          vy: -normal.y * inwardSpeed * RESTITUTION,
        });
        lastResolved.set(other.id, now);
      }
    }
  }

  limitSpeed(me);
  me.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, me.x));
  me.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, me.y));
  return outgoing;
}
