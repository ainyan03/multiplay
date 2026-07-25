import { GAME_HEIGHT, GAME_WIDTH, type PlayerState } from "./games";

const PLAYER_RADIUS = 18;
const COLLISION_DISTANCE = PLAYER_RADIUS * 2;
const RESTITUTION = .72;
const MAX_COLLISION_SPEED = 420;
const COLLISION_COOLDOWN_MS = 120;

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

      const relativeNormalSpeed = (me.vx - other.vx) * normal.x + (me.vy - other.vy) * normal.y;
      const canResolve = me.id < other.id && now - (lastResolved.get(other.id) ?? 0) >= COLLISION_COOLDOWN_MS;
      if (relativeNormalSpeed < 0 && canResolve) {
        // One deterministic peer resolves both halves, preventing duplicate network impulses.
        const impulse = -(1 + RESTITUTION) * relativeNormalSpeed * .5;
        applyLobbyImpulse(me, normal.x * impulse, normal.y * impulse);
        outgoing.push({ targetId: other.id, vx: -normal.x * impulse, vy: -normal.y * impulse });
        lastResolved.set(other.id, now);
      }
    }
  }

  limitSpeed(me);
  me.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, me.x));
  me.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, me.y));
  return outgoing;
}
