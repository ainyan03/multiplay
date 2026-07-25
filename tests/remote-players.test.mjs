import assert from "node:assert/strict";
import test from "node:test";
import { receiveRemotePlayer, sanitizeWirePlayer, smoothRemotePlayers, toWirePlayer } from "../app/remotePlayers.ts";

const NOW = 1_000_000;

const wire = (overrides = {}) => ({
  name: "PLAYER",
  x: 480,
  y: 270,
  vx: 10,
  vy: -10,
  color: "#f9e547",
  score: 3,
  seq: 1,
  ...overrides,
});

test("sanitizeWirePlayer keeps well-formed payloads intact", () => {
  const sanitized = sanitizeWirePlayer(wire({ crown: true }));
  assert.ok(sanitized);
  assert.equal(sanitized.name, "PLAYER");
  assert.equal(sanitized.color, "#f9e547");
  assert.equal(sanitized.score, 3);
  assert.equal(sanitized.x, 480);
  assert.equal(sanitized.crown, true);
});

test("sanitizeWirePlayer rejects rather than repairs hostile values", () => {
  assert.equal(sanitizeWirePlayer(null), null);
  assert.equal(sanitizeWirePlayer("state"), null);
  assert.equal(sanitizeWirePlayer([]), null, "arrays are not records");
  assert.equal(sanitizeWirePlayer(wire({ x: undefined })), null);
  assert.equal(sanitizeWirePlayer(wire({ x: Number.NaN })), null);
  assert.equal(sanitizeWirePlayer(wire({ y: Number.POSITIVE_INFINITY })), null);
  assert.equal(sanitizeWirePlayer(wire({ x: 1_000_000 })), null, "far outside the field");
  assert.equal(sanitizeWirePlayer(wire({ vx: -1_000_000 })), null, "impossible speed");
  assert.equal(sanitizeWirePlayer(wire({ name: "X".repeat(200) })), null);
  assert.equal(sanitizeWirePlayer(wire({ color: "url(javascript:alert(1))" })), null);
  assert.equal(sanitizeWirePlayer(wire({ color: "red" })), null, "only hex colors");
  assert.equal(sanitizeWirePlayer(wire({ score: Number.NaN })), null);
  assert.equal(sanitizeWirePlayer(wire({ score: -5 })), null);
  assert.equal(sanitizeWirePlayer(wire({ crown: "yes" })), null);
  assert.equal(sanitizeWirePlayer(wire({ seq: 1.5 })), null, "sequence must be an integer");
});

test("sanitizeWirePlayer still accepts payloads from builds without a sequence", () => {
  const legacy = wire();
  delete legacy.seq;
  const sanitized = sanitizeWirePlayer(legacy);
  assert.ok(sanitized);
  assert.equal(sanitized.seq, undefined);
});

test("toWirePlayer strips local-only fields and stamps the sequence", () => {
  const state = { id: "self", name: "SELF", x: 1, y: 2, vx: 3, vy: 4, color: "#ffffff", score: 5, seen: NOW };
  const sent = toWirePlayer(state, 42);
  assert.equal(sent.seq, 42);
  assert.equal(sent.id, undefined, "peer identity comes from the transport");
  assert.equal(sent.seen, undefined, "liveness is measured on the receiving side");
});

test("receiveRemotePlayer inserts, updates, and ignores garbage", () => {
  const players = new Map();
  const motions = new Map();

  receiveRemotePlayer(players, motions, "garbage", "peer-a", NOW);
  assert.equal(players.size, 0);

  receiveRemotePlayer(players, motions, wire({ seq: 1 }), "peer-a", NOW);
  const added = players.get("peer-a");
  assert.ok(added);
  assert.equal(added.id, "peer-a", "identity always comes from the transport");
  assert.equal(added.seen, NOW);

  added.x = 100;
  receiveRemotePlayer(players, motions, wire({ name: "RENAMED", score: 9, seq: 2 }), "peer-a", NOW + 66);
  const updated = players.get("peer-a");
  assert.equal(updated.name, "RENAMED");
  assert.equal(updated.score, 9);
  assert.equal(updated.seen, NOW + 66);
  assert.equal(updated.x, 100, "position updates flow through motion smoothing, not direct writes");
});

test("receiveRemotePlayer drops updates that arrive out of order", () => {
  const players = new Map();
  const motions = new Map();

  receiveRemotePlayer(players, motions, wire({ x: 100, seq: 5 }), "peer-a", NOW);
  receiveRemotePlayer(players, motions, wire({ x: 900, seq: 4 }), "peer-a", NOW + 10);
  assert.equal(motions.get("peer-a").x, 100, "a late packet must not rewind the remote avatar");

  receiveRemotePlayer(players, motions, wire({ x: 900, seq: 5 }), "peer-a", NOW + 20);
  assert.equal(motions.get("peer-a").x, 100, "a replayed sequence is ignored too");

  receiveRemotePlayer(players, motions, wire({ x: 300, seq: 6 }), "peer-a", NOW + 30);
  assert.equal(motions.get("peer-a").x, 300);
});

test("smoothRemotePlayers blends small deltas and snaps large ones", () => {
  const base = { name: "P", vx: 0, vy: 0, color: "#ffffff", score: 0, seen: NOW };
  const players = new Map([
    ["self", { ...base, id: "self", x: 0, y: 270 }],
    ["near", { ...base, id: "near", x: 100, y: 270 }],
    ["far", { ...base, id: "far", x: 0, y: 0 }],
  ]);
  const motions = new Map([
    ["self", { x: 900, y: 270, vx: 0, vy: 0, receivedAt: NOW, seq: 1 }],
    ["near", { x: 150, y: 270, vx: 0, vy: 0, receivedAt: NOW, seq: 1 }],
    ["far", { x: 800, y: 500, vx: 0, vy: 0, receivedAt: NOW, seq: 1 }],
  ]);

  smoothRemotePlayers(players, motions, "self", 0.016, NOW);
  assert.equal(players.get("self").x, 0, "own avatar is never smoothed");
  const near = players.get("near");
  assert.ok(near.x > 100 && near.x < 150, "small delta blends toward the target");
  assert.equal(players.get("far").x, 800, "large delta snaps immediately");
  assert.equal(players.get("far").y, 500);
});
