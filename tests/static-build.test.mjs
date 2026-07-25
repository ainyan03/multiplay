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
  await access(new URL("../dist/og.png", import.meta.url));
});
