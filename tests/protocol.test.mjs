import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePulse } from "../app/games.ts";
import { isNewerVersion, parseLobbyImpulse, parsePresence, PROTO_VERSION } from "../app/protocol.ts";
import { boundedString, finite, integer, record } from "../app/validate.ts";

const NOW = 1_000_000;

test("record accepts plain objects only", () => {
  assert.deepEqual(record({ a: 1 }), { a: 1 });
  assert.equal(record([1, 2]), null);
  assert.equal(record(null), null);
  assert.equal(record("x"), null);
});

test("finite and integer enforce range and representability", () => {
  assert.equal(finite(5, 0, 10), true);
  assert.equal(finite(Number.NaN, 0, 10), false);
  assert.equal(finite(Number.POSITIVE_INFINITY, 0, Number.MAX_VALUE), false);
  assert.equal(finite(11, 0, 10), false);
  assert.equal(integer(5, 0, 10), true);
  assert.equal(integer(5.5, 0, 10), false);
  assert.equal(integer(1e308, 0, Number.MAX_VALUE), false, "beyond safe-integer range");
});

test("boundedString rejects empty and oversized strings", () => {
  assert.equal(boundedString("ok", 4), true);
  assert.equal(boundedString("", 4), false);
  assert.equal(boundedString("toolong", 4), false);
  assert.equal(boundedString(7, 4), false);
});

test("isNewerVersion only fires for a plausible higher version", () => {
  assert.equal(isNewerVersion(PROTO_VERSION + 1), true);
  assert.equal(isNewerVersion(PROTO_VERSION), false);
  assert.equal(isNewerVersion(undefined), false, "builds predating versioning stay silent");
  assert.equal(isNewerVersion(Number.MAX_SAFE_INTEGER), false, "an absurd value must not trigger the banner");
  assert.equal(isNewerVersion("99"), false);
});

test("parsePresence validates the place and stamps the local receive time", () => {
  const parsed = parsePresence({ name: "PLAYER", place: "gem-sprint", at: 1, v: 3 }, NOW);
  assert.ok(parsed);
  assert.equal(parsed.place, "gem-sprint");
  assert.equal(parsed.at, NOW, "the sender's clock never decides staleness");
  assert.equal(parsed.v, 3);
  assert.equal(parsePresence({ name: "PLAYER", place: "nowhere" }, NOW), null);
  assert.equal(parsePresence({ name: "X".repeat(50), place: "lobby" }, NOW), null);
  assert.equal(parsePresence(null, NOW), null);
});

test("parseLobbyImpulse only accepts impulses addressed to us", () => {
  const base = { id: "peer:self:1", targetId: "self", vx: 100, vy: 0, at: NOW };
  assert.ok(parseLobbyImpulse(base, "self"));
  assert.equal(parseLobbyImpulse(base, "other"), null, "an impulse aimed elsewhere is not ours to apply");
  assert.equal(parseLobbyImpulse({ ...base, id: "" }, "self"), null);
  assert.equal(parseLobbyImpulse({ ...base, vx: 10_000 }, "self"), null, "beyond any reachable speed");
  assert.equal(parseLobbyImpulse({ ...base, vy: Number.NaN }, "self"), null);
});

test("sanitizePulse pins ownership to the sending peer", () => {
  const parsed = sanitizePulse({ id: "p1", x: 10, y: 20, born: NOW, owner: "victim" }, "attacker", NOW);
  assert.ok(parsed);
  assert.equal(parsed.owner, "attacker", "a peer cannot attribute its pulse to someone else");
});

test("sanitizePulse rejects out-of-range and out-of-window pulses", () => {
  const base = { id: "p1", x: 10, y: 20, born: NOW };
  assert.ok(sanitizePulse(base, "peer", NOW));
  assert.equal(sanitizePulse({ ...base, x: 99_999 }, "peer", NOW), null);
  assert.equal(sanitizePulse({ ...base, born: NOW - 60_000 }, "peer", NOW), null, "stale beyond its lifetime");
  assert.equal(sanitizePulse({ ...base, born: NOW + 60_000 }, "peer", NOW), null, "born too far in the future");
  assert.equal(sanitizePulse({ ...base, id: "" }, "peer", NOW), null);
  assert.equal(sanitizePulse(null, "peer", NOW), null);
});
