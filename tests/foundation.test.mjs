import assert from "node:assert/strict";
import test from "node:test";
import { correctedRoomNow, observeSkew, peerSkews } from "../app/clock.ts";
import { hashString, mulberry32 } from "../app/rng.ts";
import { advanceFixedSteps } from "../app/timestep.ts";

const NOW = 1_000_000;

test("observeSkew keeps the least-delayed sample per peer", () => {
  const store = new Map();
  observeSkew(store, "peer-a", NOW - 100, NOW);
  observeSkew(store, "peer-a", NOW - 100, NOW + 250);
  observeSkew(store, "peer-a", NOW - 100, NOW + 40);
  assert.deepEqual(peerSkews(store), [100], "transit jitter is discarded, the offset is not");
});

test("observeSkew forgets samples beyond the window", () => {
  const store = new Map();
  observeSkew(store, "peer-a", NOW - 5_000, NOW, 3);
  for (let index = 0; index < 3; index += 1) observeSkew(store, "peer-a", NOW - 100, NOW + index);
  assert.deepEqual(peerSkews(store), [100], "an expired outlier no longer pins the estimate");
});

test("observeSkew ignores non-finite timestamps", () => {
  const store = new Map();
  observeSkew(store, "peer-a", Number.NaN, NOW);
  assert.deepEqual(peerSkews(store), []);
});

test("correctedRoomNow lands two differently-set clocks on the same instant", () => {
  const skewed = correctedRoomNow(NOW, [-30_000]);
  const other = correctedRoomNow(NOW + 30_000, [30_000]);
  assert.equal(skewed, other, "both peers must agree on room time");
});

test("correctedRoomNow is a no-op when every clock agrees", () => {
  assert.equal(correctedRoomNow(NOW, []), NOW);
  assert.equal(correctedRoomNow(NOW, [0, 0, 0]), NOW);
});

test("correctedRoomNow resists a single extreme clock", () => {
  const sane = correctedRoomNow(NOW, [0, 0, 0, 0]);
  const withOutlier = correctedRoomNow(NOW, [0, 0, 0, 0, 9_000_000]);
  assert.equal(withOutlier, sane, "the median ignores one absurd peer");
});

test("mulberry32 replays the same stream for the same seed", () => {
  const first = mulberry32(12345);
  const second = mulberry32(12345);
  const a = Array.from({ length: 20 }, first);
  const b = Array.from({ length: 20 }, second);
  assert.deepEqual(a, b);
  assert.ok(a.every((value) => value >= 0 && value < 1), "values stay in [0,1)");
  assert.notDeepEqual(a, Array.from({ length: 20 }, mulberry32(12346)));
});

test("hashString is stable and seeds distinct streams", () => {
  assert.equal(hashString("peer:npc:0"), hashString("peer:npc:0"));
  assert.notEqual(hashString("peer:npc:0"), hashString("peer:npc:1"));
  assert.ok(Number.isSafeInteger(hashString("x")) && hashString("x") >= 0);
});

test("advanceFixedSteps emits whole steps and carries the remainder", () => {
  const first = advanceFixedSteps(0, 25, 16, 5);
  assert.equal(first.steps, 1);
  assert.equal(first.accumulator, 9);
  const second = advanceFixedSteps(first.accumulator, 25, 16, 5);
  assert.equal(second.steps, 2, "the carried remainder eventually pays for a step");
  assert.equal(second.accumulator, 2);
});

test("advanceFixedSteps caps the catch-up burst after a stall", () => {
  const result = advanceFixedSteps(0, 10_000, 16, 5);
  assert.equal(result.steps, 5, "a restored tab must not replay every missed step");
  assert.ok(result.accumulator <= 16, "the dropped backlog is not carried forward");
});

test("advanceFixedSteps tolerates degenerate input", () => {
  assert.deepEqual(advanceFixedSteps(0, -5, 16, 5), { steps: 0, accumulator: 0 });
  assert.deepEqual(advanceFixedSteps(0, 100, 0, 5), { steps: 0, accumulator: 0 });
});
