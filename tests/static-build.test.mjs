import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("builds a GitHub Pages-ready multiplayer arcade", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const assets = await readdir(new URL("../dist/assets/", import.meta.url));
  const scripts = await Promise.all(
    assets.filter((name) => name.endsWith(".js")).map((name) => readFile(new URL(`../dist/assets/${name}`, import.meta.url), "utf8")),
  );
  assert.match(html, /MULTIPLAY/);
  assert.match(html, /\/multiplay\/assets\//);
  assert.ok(scripts.some((source) => source.includes("GEM SPRINT")));
  assert.ok(scripts.some((source) => source.includes("CROWN CHASE")));
  assert.ok(scripts.some((source) => source.includes("PULSE PUSH")));
  assert.ok(scripts.some((source) => source.includes("LOBBY PLAZA")));
  assert.ok(scripts.some((source) => source.includes("GLOBAL CHAT")));
  assert.ok(scripts.some((source) => source.includes("presence-v1")));
  assert.ok(scripts.some((source) => source.includes("chat-v1")));
  assert.ok(scripts.some((source) => source.includes("enterKeyHint")));
  assert.ok(scripts.some((source) => source.includes("mobile-controller")));
  assert.ok(scripts.some((source) => source.includes("analog-stick")));
  assert.ok(scripts.some((source) => source.includes("visibilitychange")));
  assert.ok(scripts.some((source) => source.includes("visualViewport")));
  assert.ok(scripts.some((source) => source.includes("screen-keyboard-open")));
  assert.ok(scripts.some((source) => source.includes("(pointer: fine)")));
  assert.ok(scripts.some((source) => source.includes("input-active")));
  assert.ok(scripts.some((source) => source.includes("receivedAt")));
  assert.ok(scripts.some((source) => source.includes("クリックまたはタップでメッセージを入力")));
  assert.ok(scripts.some((source) => source.includes("LOBBY MAP")));
  assert.ok(scripts.some((source) => source.includes("multiplay:chat-focus")));
  await access(new URL("../dist/og.png", import.meta.url));
});
