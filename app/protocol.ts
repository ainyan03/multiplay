import { isPlaceId, PLAYER_NAME_LIMIT, type PlaceId } from "./games.ts";
import { boundedString, finite, integer, record } from "./validate.ts";

// Bump when a wire format change would confuse an older client. Peers never
// disconnect over a mismatch; a client that sees a higher version just tells
// its user to reload, so a deploy can roll out while old tabs keep playing.
export const PROTO_VERSION = 2;
const MAX_PROTO_VERSION = 1_000_000;

export const STATE_SEND_MS = 66;

const APP_BASE_ID = "ainyan-multiplay-arcade-v2";
const LOCAL_HOSTS = new Set(["localhost", "::1", "[::1]", ""]);
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Loopback plus the 10/8, 172.16/12 and 192.168/16 ranges a LAN hands out. */
function isPrivateAddress(host: string) {
  const parts = IPV4.exec(host);
  // Matching on the whole address, not a prefix: "10.example.com" is a public
  // hostname that merely begins with the same characters.
  if (!parts) return false;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}

/**
 * Which world a page belongs to. Rooms are identified by the app id alone, so
 * without this a page served from a laptop joins the very same rooms as the
 * published site, and a forgotten dev tab lingers there as a real player.
 *
 * Every private address collapses into one bucket rather than being kept apart
 * by origin, so a phone opening the dev server over the LAN still meets the
 * desktop that is serving it. Ports are ignored for the same reason.
 */
export function worldKey(hostname: string) {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith(".local") || isPrivateAddress(host)) return "local";
  return host;
}

export function appIdFor(hostname: string) {
  return `${APP_BASE_ID}-${worldKey(hostname)}`;
}

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
