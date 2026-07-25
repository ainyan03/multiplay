import assert from "node:assert/strict";
import test from "node:test";
import { arenaAt, buildSoftBlocks, cellCenterX, cellCenterY, cellIndex, FUSE_MS, isHardWall, COLS, ROWS } from "../app/arena.ts";
import {
  addBomb,
  createArenaRuntime,
  DEATH_MS,
  MAX_LIVE_BOMBS,
  sanitizeBombEvent,
  stepArena,
  tryPlaceBomb,
} from "../app/arenaGame.ts";

const T0 = 2_000_000;
const silent = () => undefined;

const player = (col, row, overrides = {}) => ({
  id: "self",
  name: "SELF",
  x: cellCenterX(col),
  y: cellCenterY(row),
  vx: 0,
  vy: 0,
  color: "#ffffff",
  score: 0,
  seen: T0,
  ...overrides,
});

const step = (runtime, me, roomNow, extra = {}) => stepArena({
  runtime,
  me,
  players: new Map([[me.id, me]]),
  selfId: "self",
  dirX: 0,
  dirY: 0,
  dt: 1 / 60,
  roomNow,
  playTone: silent,
  ...extra,
});

/** A cell whose neighbour below holds a soft block, so a bomb there scores. */
function cellNextToBlock() {
  const blocks = buildSoftBlocks();
  for (let row = 1; row < ROWS - 2; row += 1) {
    for (let col = 1; col < COLS - 1; col += 1) {
      if (isHardWall(col, row) || blocks.has(cellIndex(col, row))) continue;
      if (blocks.has(cellIndex(col, row + 1))) return { col, row };
    }
  }
  throw new Error("the seeded layout always has a bombable block");
}

test("placing a bomb records it where the player stands", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  const bomb = tryPlaceBomb(runtime, me, "self", T0);
  assert.ok(bomb);
  assert.equal(bomb.col, 1);
  assert.equal(bomb.row, 1);
  assert.equal(bomb.owner, "self");
});

test("a player may not stack bombs beyond the limit", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  for (let index = 0; index < MAX_LIVE_BOMBS; index += 1) {
    const bomb = tryPlaceBomb(runtime, { ...me, x: cellCenterX(1 + index * 2) }, "self", T0 + index * 500);
    assert.ok(bomb, `bomb ${index} is allowed`);
    addBomb(runtime, bomb);
  }
  const extra = tryPlaceBomb(runtime, { ...me, x: cellCenterX(7) }, "self", T0 + 1_500);
  assert.equal(extra, null, "the limit holds while the earlier bombs are live");
});

test("a cell that already holds a bomb refuses another", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  addBomb(runtime, tryPlaceBomb(runtime, me, "self", T0));
  assert.equal(tryPlaceBomb(runtime, me, "self", T0 + 400), null);
});

test("a dead player cannot place bombs", () => {
  const runtime = createArenaRuntime();
  runtime.deadUntil = T0 + 1_000;
  assert.equal(tryPlaceBomb(runtime, player(1, 1), "self", T0), null);
});

test("addBomb ignores a repeated id", () => {
  const runtime = createArenaRuntime();
  const bomb = { id: "b1", owner: "peer", col: 1, row: 1, at: T0 };
  assert.equal(addBomb(runtime, bomb), true);
  assert.equal(addBomb(runtime, bomb), false);
  assert.equal(runtime.bombs.length, 1);
});

test("sanitizeBombEvent credits the sending peer, not the payload", () => {
  const bomb = sanitizeBombEvent({ id: "b1", owner: "victim", col: 3, row: 1, at: T0 }, "attacker", T0);
  assert.ok(bomb);
  assert.equal(bomb.owner, "attacker");
});

test("sanitizeBombEvent rejects impossible placements", () => {
  const base = { id: "b1", col: 3, row: 1, at: T0 };
  assert.ok(sanitizeBombEvent(base, "peer", T0));
  assert.equal(sanitizeBombEvent({ ...base, col: 0, row: 0 }, "peer", T0), null, "inside a pillar");
  assert.equal(sanitizeBombEvent({ ...base, col: 99 }, "peer", T0), null, "off the grid");
  assert.equal(sanitizeBombEvent({ ...base, col: 1.5 }, "peer", T0), null, "between cells");
  assert.equal(sanitizeBombEvent({ ...base, at: T0 - 600_000 }, "peer", T0), null, "rewriting the past");
  assert.equal(sanitizeBombEvent({ ...base, id: "" }, "peer", T0), null);
  assert.equal(sanitizeBombEvent(null, "peer", T0), null);
});

test("standing in your own blast kills you", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  addBomb(runtime, tryPlaceBomb(runtime, me, "self", T0));
  step(runtime, me, T0 + 100);
  assert.equal(runtime.deadUntil, 0, "the fuse is still running");
  step(runtime, me, T0 + FUSE_MS + 10);
  assert.equal(runtime.deadUntil, T0 + FUSE_MS + 10 + DEATH_MS, "the blast catches the player who set it");
});

test("a blast that breaks blocks scores for the bomb's owner", () => {
  const spot = cellNextToBlock();
  const runtime = createArenaRuntime();
  // Stand clear of the blast: dying in it would subtract more than the block pays.
  const me = player(COLS - 2, ROWS - 2);
  addBomb(runtime, { id: "mine", owner: "self", col: spot.col, row: spot.row, at: T0 });
  step(runtime, me, T0 + FUSE_MS + 10);
  assert.ok(me.score > 0, "breaking a block is worth something");

  const before = me.score;
  step(runtime, me, T0 + FUSE_MS + 20);
  assert.equal(me.score, before, "the same detonation is never counted twice");
});

test("blowing yourself up costs more than the block was worth", () => {
  const spot = cellNextToBlock();
  const runtime = createArenaRuntime();
  const me = player(spot.col, spot.row, { score: 10 });
  addBomb(runtime, tryPlaceBomb(runtime, me, "self", T0));
  step(runtime, me, T0 + FUSE_MS + 10);
  assert.ok(me.score < 10, "standing in your own blast is a net loss");
});

test("a bomb from another peer does not score for us", () => {
  const spot = cellNextToBlock();
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  addBomb(runtime, { id: "theirs", owner: "peer-b", col: spot.col, row: spot.row, at: T0 });
  step(runtime, me, T0 + FUSE_MS + 10);
  assert.equal(me.score, 0);
});

test("walls stop a player from leaving the arena", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  for (let tick = 0; tick < 240; tick += 1) {
    step(runtime, me, T0 + tick * 16, { dirX: -1, dirY: -1 });
  }
  const arena = arenaAt([], T0);
  assert.ok(!arena.softBlocks.has(cellIndex(1, 1)));
  assert.ok(me.x > cellCenterX(1) - 40, "the border wall holds");
  assert.ok(me.y > cellCenterY(1) - 40);
});

test("a player walks freely down an open corridor", () => {
  const runtime = createArenaRuntime();
  const me = player(1, 1);
  const startX = me.x;
  for (let tick = 0; tick < 60; tick += 1) {
    step(runtime, me, T0 + tick * 16, { dirX: 1, dirY: 0 });
  }
  assert.ok(me.x > startX + 20, "movement is continuous, not locked to cells");
});
