import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLobbyImpulse,
  isLobbyImpulsePlausible,
  resolveLobbyCollisions,
  steerLobbyPlayer,
} from "../app/lobbyPhysics.ts";

const NOW = 1_000_000;

const player = (overrides = {}) => ({
  id: "self",
  name: "SELF",
  x: 480,
  y: 270,
  vx: 0,
  vy: 0,
  color: "#fff",
  score: 0,
  seen: NOW,
  ...overrides,
});

test("steerLobbyPlayer strips momentum opposing fresh input", () => {
  const me = player({ vx: -200, vy: 50 });
  steerLobbyPlayer(me, 1, 0, 0.016);
  assert.ok(me.vx > 0, "opposing horizontal momentum is removed before accelerating");
  assert.ok(me.vy > 0 && me.vy < 50, "sideways momentum decays but is not zeroed");
});

test("applyLobbyImpulse caps the resulting speed", () => {
  const me = player({ vx: 400 });
  applyLobbyImpulse(me, 400, 0);
  assert.ok(Math.abs(Math.hypot(me.vx, me.vy) - 420) < 1e-9);
});

test("isLobbyImpulsePlausible accepts a push away from a nearby fresh source", () => {
  const me = player();
  const source = player({ id: "peer", x: 450, seen: NOW - 100 });
  assert.equal(isLobbyImpulsePlausible(me, source, 100, 0, NOW), true);
});

test("isLobbyImpulsePlausible rejects implausible impulses", () => {
  const me = player();
  const source = player({ id: "peer", x: 450, seen: NOW - 100 });
  assert.equal(isLobbyImpulsePlausible(me, source, Number.NaN, 0, NOW), false, "non-finite");
  assert.equal(isLobbyImpulsePlausible(me, source, 0, 0, NOW), false, "zero magnitude");
  assert.equal(isLobbyImpulsePlausible(me, source, 500, 0, NOW), false, "too strong");
  assert.equal(isLobbyImpulsePlausible(me, source, 0, 100, NOW), false, "wrong direction");
  assert.equal(isLobbyImpulsePlausible(me, source, -100, 0, NOW), false, "pulls toward source");
  const stale = player({ id: "peer", x: 450, seen: NOW - 1_000 });
  assert.equal(isLobbyImpulsePlausible(me, stale, 100, 0, NOW), false, "stale source");
  const distant = player({ id: "peer", x: 300, seen: NOW - 100 });
  assert.equal(isLobbyImpulsePlausible(me, distant, 100, 0, NOW), false, "too far apart");
});

test("resolveLobbyCollisions separates overlapping players and emits one impulse", () => {
  const me = player({ vx: 120 });
  const other = player({ id: "peer", x: 500 });
  const players = new Map([[me.id, me], [other.id, other]]);
  const lastResolved = new Map();

  const outgoing = resolveLobbyCollisions(me, players, NOW, lastResolved);

  assert.ok(me.x < 480, "overlap pushes me away from the other player");
  assert.equal(me.vx, 0, "the inward momentum is fully handed to the impulse");
  assert.equal(outgoing.length, 1, "cooldown limits the two-pass solver to one impulse");
  assert.equal(outgoing[0].targetId, "peer");
  assert.ok(outgoing[0].vx > 0, "the other player is pushed away from me");

  const again = resolveLobbyCollisions(me, players, NOW + 50, lastResolved);
  assert.equal(again.length, 0, "cooldown suppresses immediate re-impulses");
});

test("resolveLobbyCollisions ignores stale players and clamps to the field", () => {
  const me = player({ x: 2, y: -50 });
  const stale = player({ id: "peer", x: 4, seen: NOW - 5_000 });
  const players = new Map([[me.id, me], [stale.id, stale]]);

  const outgoing = resolveLobbyCollisions(me, players, NOW, new Map());

  assert.equal(outgoing.length, 0, "stale players do not collide");
  assert.equal(me.x, 18, "x clamps to the player radius");
  assert.equal(me.y, 18, "y clamps to the player radius");
});
