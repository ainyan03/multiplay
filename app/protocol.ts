import { isPlaceId, PLAYER_NAME_LIMIT, type PlaceId } from "./games.ts";
import { boundedString, finite, integer, record } from "./validate.ts";

// Bump when a wire format change would confuse an older client. Peers never
// disconnect over a mismatch; a client that sees a higher version just tells
// its user to reload, so a deploy can roll out while old tabs keep playing.
export const PROTO_VERSION = 2;
const MAX_PROTO_VERSION = 1_000_000;

export const STATE_SEND_MS = 66;

export type PresencePayload = { name: string; place: PlaceId; at: number; v?: number };
export type LobbyImpulsePayload = { id: string; targetId: string; vx: number; vy: number; at: number };

const MAX_IMPULSE_SPEED = 430;

// A peer reporting a version above ours is running a newer build.
export function isNewerVersion(value: unknown) {
  return integer(value, 1, MAX_PROTO_VERSION) && value > PROTO_VERSION;
}

export function parsePresence(value: unknown, now: number): PresencePayload | null {
  const item = record(value);
  if (!item) return null;
  if (typeof item.name !== "string" || item.name.length > PLAYER_NAME_LIMIT) return null;
  if (!isPlaceId(item.place)) return null;
  return {
    name: item.name,
    place: item.place,
    at: now,
    ...(typeof item.v === "number" ? { v: item.v } : {}),
  };
}

export function parseLobbyImpulse(value: unknown, selfPeerId: string): LobbyImpulsePayload | null {
  const item = record(value);
  if (!item) return null;
  if (!boundedString(item.id, 160) || item.targetId !== selfPeerId) return null;
  if (!finite(item.vx, -MAX_IMPULSE_SPEED, MAX_IMPULSE_SPEED)) return null;
  if (!finite(item.vy, -MAX_IMPULSE_SPEED, MAX_IMPULSE_SPEED)) return null;
  if (!finite(item.at, 0, Number.MAX_SAFE_INTEGER)) return null;
  return { id: item.id, targetId: item.targetId, vx: item.vx, vy: item.vy, at: item.at };
}
