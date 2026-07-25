import assert from "node:assert/strict";
import test from "node:test";
import { appIdFor, isNewerVersion, parseLobbyImpulse, parsePresence, PROTO_VERSION, worldKey } from "../app/protocol.ts";
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

test("worldKey keeps the published site apart from anything served locally", () => {
  assert.equal(worldKey("ainyan03.github.io"), "ainyan03.github.io");
  assert.notEqual(worldKey("localhost"), worldKey("ainyan03.github.io"));
  assert.notEqual(worldKey("staging.example.com"), worldKey("ainyan03.github.io"));
  assert.equal(worldKey("AINYAN03.GITHUB.IO"), "ainyan03.github.io", "hostnames are case-insensitive");
});

test("worldKey puts every locally served address in one world", () => {
  // A phone opening the dev server over the LAN must still meet the desktop.
  for (const host of ["localhost", "127.0.0.1", "::1", "192.168.1.5", "10.0.0.3", "172.16.4.2", "macbook.local"]) {
    assert.equal(worldKey(host), "local", `${host} is local`);
  }
});

test("worldKey does not mistake a public address for a private one", () => {
  // 172.32/12 is outside the private range, as is anything merely starting with 10.
  assert.equal(worldKey("172.32.0.1"), "172.32.0.1");
  assert.equal(worldKey("104.20.1.1"), "104.20.1.1");
  assert.equal(worldKey("10.example.com"), "10.example.com");
});

test("appIdFor separates worlds but stays stable for one host", () => {
  assert.equal(appIdFor("localhost"), appIdFor("192.168.0.9"), "one local world");
  assert.notEqual(appIdFor("localhost"), appIdFor("ainyan03.github.io"));
  assert.equal(appIdFor("ainyan03.github.io"), appIdFor("ainyan03.github.io"));
  assert.ok(appIdFor("ainyan03.github.io").startsWith("ainyan-multiplay-arcade-v2-"));
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

