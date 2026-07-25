import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_LOG_LIMIT, formatChatTimestamp, mergeChatEntries, sanitizeChatHistory, sanitizeChatPayload } from "../app/chat.ts";

const NOW = 1_000_000_000;

const payload = (overrides = {}) => ({
  id: "author:1:abc",
  name: "PLAYER",
  text: "hello",
  at: NOW - 500,
  place: "lobby",
  ...overrides,
});

test("formatChatTimestamp shows time today and date for older messages", () => {
  const now = new Date(2026, 6, 25, 18, 30).getTime();
  const today = new Date(2026, 6, 25, 9, 7).getTime();
  const older = new Date(2026, 6, 24, 23, 59).getTime();
  assert.equal(formatChatTimestamp(today, now), "09:07");
  assert.equal(formatChatTimestamp(older, now), "7/24 23:59");
});

test("sanitizeChatPayload accepts a well-formed message", () => {
  const sanitized = sanitizeChatPayload(payload({ text: "  hello  " }), NOW);
  assert.ok(sanitized);
  assert.equal(sanitized.text, "hello", "surrounding whitespace is trimmed");
  assert.equal(sanitized.at, NOW - 500);
});

test("sanitizeChatPayload rejects malformed payloads", () => {
  assert.equal(sanitizeChatPayload(null, NOW), null);
  assert.equal(sanitizeChatPayload("hello", NOW), null);
  assert.equal(sanitizeChatPayload([], NOW), null, "arrays are not records");
  assert.equal(sanitizeChatPayload(payload({ id: 42 }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ id: "" }), NOW), null, "an empty id cannot dedupe");
  assert.equal(sanitizeChatPayload(payload({ text: 7 }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ at: Number.NaN }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ place: "somewhere" }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ text: "   " }), NOW), null);
});

test("sanitizeChatPayload rejects oversized fields instead of trimming them", () => {
  assert.equal(sanitizeChatPayload(payload({ id: "x".repeat(500) }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ name: "VERY-LONG-PLAYER-NAME" }), NOW), null);
  assert.equal(sanitizeChatPayload(payload({ text: "y".repeat(500) }), NOW), null);
});

test("sanitizeChatPayload pins timestamps into a window around now", () => {
  const future = sanitizeChatPayload(payload({ at: NOW + 60_000 }), NOW);
  assert.ok(future);
  assert.equal(future.at, NOW, "a clock running ahead cannot park a message at the bottom");

  const ancient = sanitizeChatPayload(payload({ at: 1 }), NOW);
  assert.ok(ancient);
  assert.equal(ancient.at, NOW - 24 * 60 * 60 * 1000, "nor can a backdated one pin itself to the top");

  const skewed = sanitizeChatPayload(payload({ at: NOW - 30_000 }), NOW);
  assert.ok(skewed);
  assert.equal(skewed.at, NOW - 30_000, "a modestly skewed peer is left alone");
});

test("sanitizeChatHistory refuses an oversized batch without walking it", () => {
  const messages = Array.from({ length: 41 }, (_, index) => payload({ id: `m${index}` }));
  assert.equal(sanitizeChatHistory({ messages }, NOW), null);
  assert.equal(sanitizeChatHistory({ messages: messages.slice(0, 40) }, NOW).length, 40);
  assert.equal(sanitizeChatHistory({ messages: "nope" }, NOW), null);
  assert.equal(sanitizeChatHistory(null, NOW), null);
});

test("sanitizeChatHistory drops only the malformed entries of a valid batch", () => {
  const messages = [payload({ id: "ok" }), payload({ id: "" }), payload({ id: "ok2" })];
  const parsed = sanitizeChatHistory({ messages }, NOW);
  assert.deepEqual(parsed.map((entry) => entry.id), ["ok", "ok2"]);
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

test("mergeChatEntries orders equal timestamps deterministically", () => {
  const first = { ...payload({ id: "aaa", at: NOW }), authorId: "peer-a" };
  const second = { ...payload({ id: "bbb", at: NOW }), authorId: "peer-b" };
  const forward = mergeChatEntries([first], [second]).map((entry) => entry.id);
  const reversed = mergeChatEntries([second], [first]).map((entry) => entry.id);
  assert.deepEqual(forward, ["aaa", "bbb"]);
  assert.deepEqual(reversed, forward, "arrival order must not change the rendering order");
});

test("mergeChatEntries caps the log length", () => {
  const system = { ...payload({ id: "welcome" }), authorId: "system", system: true };
  const flood = Array.from({ length: CHAT_LOG_LIMIT + 50 }, (_, index) => ({
    ...payload({ id: `m${index}`, at: NOW - 1000 + index }),
    authorId: "peer-a",
  }));
  const merged = mergeChatEntries([system], flood);
  assert.equal(merged.length, CHAT_LOG_LIMIT);
  assert.equal(merged[0].id, "welcome");
  assert.equal(merged.at(-1).id, `m${CHAT_LOG_LIMIT + 49}`);
});
