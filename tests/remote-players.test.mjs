import assert from "node:assert/strict";
import test from "node:test";
import { GAME_WIDTH } from "../app/games.ts";
import { receiveRemotePlayer, sanitizeWirePlayer, smoothRemotePlayers } from "../app/remotePlayers.ts";

const NOW = 1_000_000;

const wire = (overrides = {}) => ({
  id: "peer-a",
  name: "PLAYER",
  x: 480,
  y: 270,
  vx: 10,
  vy: -10,
  color: "#f9e547",
  score: 3,
  ...overrides,
});

test("sanitizeWirePlayer rejects payloads without finite coordinates", () => {
  assert.equal(sanitizeWirePlayer(null), null);
  assert.equal(sanitizeWirePlayer("state"), null);
  assert.equal(sanitizeWirePlayer(wire({ x: undefined })), null);
  assert.equal(sanitizeWirePlayer(wire({ x: Number.NaN })), null);
  assert.equal(sanitizeWirePlayer(wire({ y: Number.POSITIVE_INFINITY })), null);
});

test("sanitizeWirePlayer normalizes hostile field values", () => {
  const sanitized = sanitizeWirePlayer(wire({
    name: "X".repeat(200),
    color: "url(javascript:alert(1))",
    score: Number.NaN,
    crown: "yes",
    x: 1_000_000,
    vx: -1_000_000,
  }));
  assert.ok(sanitized);
  assert.equal(sanitized.name.length, 14);
  assert.equal(sanitized.color, "#8fa3bd");
  assert.equal(sanitized.score, 0);
  assert.equal(sanitized.crown, false);
  assert.equal(sanitized.x, GAME_WIDTH);
  assert.equal(sanitized.vx, -1_000);
});

test("sanitizeWirePlayer keeps well-formed payloads intact", () => {
  const sanitized = sanitizeWirePlayer(wire());
  assert.ok(sanitized);
  assert.equal(sanitized.name, "PLAYER");
  assert.equal(sanitized.color, "#f9e547");
  assert.equal(sanitized.score, 3);
  assert.equal(sanitized.x, 480);
});

test("receiveRemotePlayer inserts, updates, and ignores garbage", () => {
  const players = new Map();
  const motions = new Map();

  receiveRemotePlayer(players, motions, "garbage", "peer-a", NOW);
  assert.equal(players.size, 0);

  receiveRemotePlayer(players, motions, wire({ id: "spoofed-id" }), "peer-a", NOW);
  const added = players.get("peer-a");
  assert.ok(added);
  assert.equal(added.id, "peer-a");
  assert.equal(added.seen, NOW);
  assert.equal(motions.get("peer-a").receivedAt, NOW);

  added.x = 100;
  receiveRemotePlayer(players, motions, wire({ name: "RENAMED", score: 9 }), "peer-a", NOW + 66);
  const updated = players.get("peer-a");
  assert.equal(updated.name, "RENAMED");
  assert.equal(updated.score, 9);
  assert.equal(updated.seen, NOW + 66);
  assert.equal(updated.x, 100, "position updates flow through motion smoothing, not direct writes");
});

test("smoothRemotePlayers blends small deltas and snaps large ones", () => {
  const players = new Map([
    ["self", { ...wire({ id: "self", x: 0 }), seen: NOW }],
    ["near", { ...wire({ id: "near", x: 100, vx: 0, vy: 0 }), seen: NOW }],
    ["far", { ...wire({ id: "far", x: 0, y: 0, vx: 0, vy: 0 }), seen: NOW }],
  ]);
  const motions = new Map([
    ["self", { x: 900, y: 270, vx: 0, vy: 0, receivedAt: NOW }],
    ["near", { x: 150, y: 270, vx: 0, vy: 0, receivedAt: NOW }],
    ["far", { x: 800, y: 500, vx: 0, vy: 0, receivedAt: NOW }],
  ]);

  smoothRemotePlayers(players, motions, "self", 0.016, NOW);
  assert.equal(players.get("self").x, 0, "own avatar is never smoothed");
  const near = players.get("near");
  assert.ok(near.x > 100 && near.x < 150, "small delta blends toward the target");
  assert.equal(players.get("far").x, 800, "large delta snaps immediately");
  assert.equal(players.get("far").y, 500);
});
