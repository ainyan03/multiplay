import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_LOG_LIMIT, mergeChatEntries, sanitizeChatPayload } from "../app/chat.ts";

const NOW = 1_000_000;

const payload = (overrides = {}) => ({
  id: "author:1:abc",
  name: "PLAYER",
  text: "hello",
  at: NOW - 500,
  place: "lobby",
  ...overrides,
});

test("sanitizeChatPayload rejects malformed payloads", () => {
  assert.equal(sanitizeChatPayload(null, NOW), null);
  assert.equal(sanitizeChatPayload("hello", NOW), null);
  assert.equal(sanitizeChatPayload(payload({ id: 42 }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ text: 7 }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ at: Number.NaN }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ place: "somewhere" }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ text: "   " }), NOW), null);
});

test("sanitizeChatPayload truncates oversized fields", () => {
  const sanitized = sanitizeChatPayload(payload({
    id: "x".repeat(500),
    name: "VERY-LONG-PLAYER-NAME",
    text: `  ${"y".repeat(500)}  `,
  }), NOW);
  assert.ok(sanitized);
  assert.equal(sanitized.id.length, 120);
  assert.equal(sanitized.name.length, 14);
  assert.equal(sanitized.text.length, 180);
});

test("sanitizeChatPayload clamps future timestamps to now", () => {
  const sanitized = sanitizeChatPayload(payload({ at: NOW + 60_000 }), NOW);
  assert.ok(sanitized);
  assert.equal(sanitized.at, NOW);
  const past = sanitizeChatPayload(payload({ at: NOW - 60_000 }), NOW);
  assert.ok(past);
  assert.equal(past.at, NOW - 60_000);
});

test("mergeChatEntries keeps the first entry for a message id", () => {
  const original = { ...payload(), authorId: "peer-a", text: "original" };
  const forged = { ...payload(), authorId: "peer-b", text: "forged" };
  const merged = mergeChatEntries([original], [forged]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "original");
  assert.equal(merged[0].authorId, "peer-a");
});

test("mergeChatEntries pins the system entry and sorts by time", () => {
  const system = { ...payload({ id: "welcome", at: NOW }), authorId: "system", system: true };
  const older = { ...payload({ id: "m1", at: NOW - 900 }), authorId: "peer-a" };
  const newer = { ...payload({ id: "m2", at: NOW - 100 }), authorId: "peer-b" };
  const merged = mergeChatEntries([system, newer], [older]);
  assert.deepEqual(merged.map((entry) => entry.id), ["welcome", "m1", "m2"]);
});

test("mergeChatEntries caps the log length", () => {
  const system = { ...payload({ id: "welcome" }), authorId: "system", system: true };
  const flood = Array.from({ length: CHAT_LOG_LIMIT + 50 }, (_, index) => ({
    ...payload({ id: `m${index}`, at: NOW + index }),
    authorId: "peer-a",
  }));
  const merged = mergeChatEntries([system], flood);
  assert.equal(merged.length, CHAT_LOG_LIMIT);
  assert.equal(merged[0].id, "welcome");
  assert.equal(merged.at(-1).id, `m${CHAT_LOG_LIMIT + 49}`);
});
