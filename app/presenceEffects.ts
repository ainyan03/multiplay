import type { PlayerState } from "./games.ts";

export const PRESENCE_EFFECT_MS = 900;

export type PresenceEffect = {
  id: string;
  kind: "join" | "leave";
  x: number;
  y: number;
  color: string;
  at: number;
};

export function makePresenceEffect(
  player: Pick<PlayerState, "id" | "x" | "y" | "color">,
  kind: PresenceEffect["kind"],
  at: number,
): PresenceEffect {
  return { id: `${player.id}:${kind}:${at}`, kind, x: player.x, y: player.y, color: player.color, at };
}

export function activePresenceEffects(effects: PresenceEffect[], now: number) {
  return effects.filter((effect) => now - effect.at < PRESENCE_EFFECT_MS);
}
