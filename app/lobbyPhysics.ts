import { GAME_HEIGHT, GAME_WIDTH, type PlayerState } from "./games";

const PLAYER_RADIUS = 18;
const COLLISION_DISTANCE = PLAYER_RADIUS * 2;
const RESTITUTION = .72;
const MAX_COLLISION_SPEED = 420;

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

export function resolveLobbyCollisions(me: PlayerState, players: Map<string, PlayerState>, now: number) {
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
      if (relativeNormalSpeed < 0) {
        // Equal-mass impulse. A little energy is lost to keep network jitter under control.
        const impulse = -(1 + RESTITUTION) * relativeNormalSpeed * .5;
        me.vx += normal.x * impulse;
        me.vy += normal.y * impulse;
      }
    }
  }

  const speed = Math.hypot(me.vx, me.vy);
  if (speed > MAX_COLLISION_SPEED) {
    const scale = MAX_COLLISION_SPEED / speed;
    me.vx *= scale;
    me.vy *= scale;
  }
  me.x = Math.max(PLAYER_RADIUS, Math.min(GAME_WIDTH - PLAYER_RADIUS, me.x));
  me.y = Math.max(PLAYER_RADIUS, Math.min(GAME_HEIGHT - PLAYER_RADIUS, me.y));
}
