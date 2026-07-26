import assert from "node:assert/strict";
import test from "node:test";

import { activePresenceEffects, makePresenceEffect, PRESENCE_EFFECT_MS } from "../app/presenceEffects.ts";

test("makePresenceEffect preserves the last visible player position", () => {
  const effect = makePresenceEffect({ id: "peer-a", x: 120, y: 80, color: "#68e6c1" }, "leave", 1_000);
  assert.deepEqual(effect, {
    id: "peer-a:leave:1000",
    kind: "leave",
    x: 120,
    y: 80,
    color: "#68e6c1",
    at: 1_000,
  });
});

test("activePresenceEffects removes animations after their lifetime", () => {
  const effect = makePresenceEffect({ id: "peer-a", x: 120, y: 80, color: "#68e6c1" }, "join", 1_000);
  assert.deepEqual(activePresenceEffects([effect], 1_000 + PRESENCE_EFFECT_MS - 1), [effect]);
  assert.deepEqual(activePresenceEffects([effect], 1_000 + PRESENCE_EFFECT_MS), []);
});
