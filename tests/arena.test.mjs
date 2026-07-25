import assert from "node:assert/strict";
import test from "node:test";
import {
  arenaAt,
  BLAST_MS,
  buildSoftBlocks,
  cellAt,
  cellCenterX,
  cellCenterY,
  cellIndex,
  COLS,
  FUSE_MS,
  isHardWall,
  pruneBombs,
  REGROW_MS,
  ROWS,
  SPAWN_CELLS,
} from "../app/arena.ts";

const T0 = 1_000_000;
const bomb = (id, col, row, at, owner = "peer-a") => ({ id, owner, col, row, at });

test("the border and the pillar lattice are permanent", () => {
  assert.equal(isHardWall(0, 5), true);
  assert.equal(isHardWall(COLS - 1, 5), true);
  assert.equal(isHardWall(5, 0), true);
  assert.equal(isHardWall(5, ROWS - 1), true);
  assert.equal(isHardWall(2, 2), true, "even/even is a pillar");
  assert.equal(isHardWall(1, 1), false);
  assert.equal(isHardWall(3, 2), false);
  assert.equal(isHardWall(-1, 5), true, "outside counts as solid");
});

test("spawn cells and their neighbours start clear", () => {
  const blocks = buildSoftBlocks();
  for (const spawn of SPAWN_CELLS) {
    assert.equal(isHardWall(spawn.col, spawn.row), false, `spawn ${spawn.col},${spawn.row} is walkable`);
    assert.equal(blocks.has(cellIndex(spawn.col, spawn.row)), false);
    const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .filter(([dc, dr]) => !isHardWall(spawn.col + dc, spawn.row + dr))
      .filter(([dc, dr]) => !blocks.has(cellIndex(spawn.col + dc, spawn.row + dr)));
    assert.ok(exits.length > 0, `spawn ${spawn.col},${spawn.row} has a way out`);
  }
});

test("every spawn is reachable without destroying a single block", () => {
  // With no rounds and regrowing blocks, a spawn sealed behind one block would
  // strand that player for good, so the layout must stay traversable on its own.
  const blocks = buildSoftBlocks();
  const start = SPAWN_CELLS[0];
  const seen = new Set([cellIndex(start.col, start.row)]);
  const queue = [start];
  while (queue.length) {
    const { col, row } = queue.pop();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nextCol = col + dc;
      const nextRow = row + dr;
      const key = cellIndex(nextCol, nextRow);
      if (isHardWall(nextCol, nextRow) || blocks.has(key) || seen.has(key)) continue;
      seen.add(key);
      queue.push({ col: nextCol, row: nextRow });
    }
  }
  for (const spawn of SPAWN_CELLS) {
    assert.ok(seen.has(cellIndex(spawn.col, spawn.row)), `spawn ${spawn.col},${spawn.row} is connected`);
  }
  assert.ok(seen.size > 60, "and the open area is roomy enough to move and dodge in");
});

test("the soft block layout is identical for the same seed", () => {
  assert.deepEqual([...buildSoftBlocks(42)], [...buildSoftBlocks(42)]);
  assert.notDeepEqual([...buildSoftBlocks(42)], [...buildSoftBlocks(43)]);
});

test("cell and pixel coordinates round-trip", () => {
  const cell = cellAt(cellCenterX(7), cellCenterY(4));
  assert.deepEqual(cell, { col: 7, row: 4 });
});

test("a bomb burns only after its fuse and only briefly", () => {
  const bombs = [bomb("b1", 1, 1, T0)];
  assert.equal(arenaAt(bombs, T0).blasts.size, 0, "nothing burns while the fuse runs");
  assert.equal(arenaAt(bombs, T0).liveBombs.length, 1);
  const firing = arenaAt(bombs, T0 + FUSE_MS);
  assert.ok(firing.blasts.has(cellIndex(1, 1)));
  assert.equal(firing.liveBombs.length, 0);
  assert.equal(arenaAt(bombs, T0 + FUSE_MS + BLAST_MS).blasts.size, 0, "the fire goes out");
});

test("a blast stops at a pillar", () => {
  // (2,2) is a pillar, so a bomb at (1,2) cannot burn past it.
  const snapshot = arenaAt([bomb("b1", 1, 2, T0)], T0 + FUSE_MS);
  assert.ok(snapshot.blasts.has(cellIndex(1, 2)));
  assert.equal(snapshot.blasts.has(cellIndex(2, 2)), false);
  assert.equal(snapshot.blasts.has(cellIndex(3, 2)), false);
});

test("a blast clears one soft block and no further", () => {
  const blocks = buildSoftBlocks();
  // Find a row where two soft blocks sit next to each other beyond a free cell.
  let found = null;
  for (let row = 1; row < ROWS - 1 && !found; row += 1) {
    for (let col = 1; col < COLS - 3; col += 1) {
      const open = !isHardWall(col, row) && !blocks.has(cellIndex(col, row));
      const first = !isHardWall(col + 1, row) && blocks.has(cellIndex(col + 1, row));
      const second = !isHardWall(col + 2, row) && blocks.has(cellIndex(col + 2, row));
      if (open && first && second) { found = { col, row }; break; }
    }
  }
  assert.ok(found, "the seeded layout has a bomb spot with two blocks in a row");

  const at = T0 + FUSE_MS;
  const snapshot = arenaAt([bomb("b1", found.col, found.row, T0)], at);
  assert.equal(snapshot.softBlocks.has(cellIndex(found.col + 1, found.row)), false, "the near block is gone");
  assert.equal(snapshot.softBlocks.has(cellIndex(found.col + 2, found.row)), true, "the one behind it survives");
  assert.equal(snapshot.blasts.has(cellIndex(found.col + 2, found.row)), false, "and does not catch fire");
});

test("a broken block grows back on schedule", () => {
  const blocks = buildSoftBlocks();
  let target = null;
  for (let row = 1; row < ROWS - 1 && !target; row += 1) {
    for (let col = 1; col < COLS - 2; col += 1) {
      if (!isHardWall(col, row) && !blocks.has(cellIndex(col, row)) && blocks.has(cellIndex(col + 1, row))) {
        target = { col, row }; break;
      }
    }
  }
  assert.ok(target);
  const bombs = [bomb("b1", target.col, target.row, T0)];
  const key = cellIndex(target.col + 1, target.row);
  const firedAt = T0 + FUSE_MS;
  assert.equal(arenaAt(bombs, firedAt + 1_000).softBlocks.has(key), false);
  assert.equal(arenaAt(bombs, firedAt + REGROW_MS - 1).softBlocks.has(key), false);
  assert.equal(arenaAt(bombs, firedAt + REGROW_MS).softBlocks.has(key), true, "the maze repairs itself");
});

test("a blast sets off a bomb it reaches, early", () => {
  const bombs = [bomb("b1", 1, 1, T0), bomb("b2", 1, 3, T0 + 2_000)];
  const snapshot = arenaAt(bombs, T0 + FUSE_MS);
  const chained = snapshot.detonations.find((item) => item.id === "b2");
  assert.equal(chained.firedAt, T0 + FUSE_MS, "the neighbour goes off with the first one");
  assert.ok(snapshot.blasts.has(cellIndex(1, 3)));
});

test("a bomb placed after a blast is not retroactively chained", () => {
  const bombs = [bomb("b1", 1, 1, T0), bomb("b2", 1, 3, T0 + FUSE_MS + 10)];
  const snapshot = arenaAt(bombs, T0 + FUSE_MS + 20);
  const later = snapshot.detonations.find((item) => item.id === "b2");
  assert.equal(later.firedAt, T0 + FUSE_MS + 10 + FUSE_MS, "it keeps its own fuse");
});

test("chains propagate along a clear corridor", () => {
  // Odd columns have no pillars, so a run of three bomb cells needs only the
  // gaps between them to be free of soft blocks. Which seed offers one is
  // incidental to the chaining rule under test, so search for any that does.
  let corridor = null;
  for (let seed = 1; seed <= 200 && corridor === null; seed += 1) {
    const blocks = buildSoftBlocks(seed);
    const clear = (col, row) => !isHardWall(col, row) && !blocks.has(cellIndex(col, row));
    for (let col = 1; col < COLS - 1; col += 2) {
      if ([1, 2, 3, 4, 5].every((row) => clear(col, row))) { corridor = { seed, col }; break; }
    }
  }
  assert.ok(corridor, "some seed lays out a clear corridor");

  const bombs = [
    bomb("b1", corridor.col, 1, T0),
    bomb("b2", corridor.col, 3, T0 + 100),
    bomb("b3", corridor.col, 5, T0 + 200),
  ];
  const snapshot = arenaAt(bombs, T0 + FUSE_MS, corridor.seed);
  for (const id of ["b1", "b2", "b3"]) {
    const item = snapshot.detonations.find((entry) => entry.id === id);
    assert.equal(item.firedAt, T0 + FUSE_MS, `${id} joins the chain`);
  }
});

test("a soft block between two bombs stops the chain", () => {
  const blocks = buildSoftBlocks();
  // A block in the gap absorbs the blast, so the far bomb keeps its own fuse.
  let setup = null;
  for (let col = 1; col < COLS - 1 && setup === null; col += 2) {
    for (let row = 1; row < ROWS - 3; row += 2) {
      const gap = cellIndex(col, row + 1);
      if (!isHardWall(col, row) && !isHardWall(col, row + 2) && blocks.has(gap)) {
        setup = { col, row }; break;
      }
    }
  }
  assert.ok(setup, "the seeded layout has a blocked gap between two bomb cells");

  const bombs = [bomb("b1", setup.col, setup.row, T0), bomb("b2", setup.col, setup.row + 2, T0 + 100)];
  const snapshot = arenaAt(bombs, T0 + FUSE_MS);
  const far = snapshot.detonations.find((item) => item.id === "b2");
  assert.equal(far.firedAt, T0 + 100 + FUSE_MS, "the shielded bomb is untouched");
  assert.equal(snapshot.softBlocks.has(cellIndex(setup.col, setup.row + 1)), false, "the shield itself is destroyed");
});

test("the arena does not depend on the order bombs arrived in", () => {
  const bombs = [bomb("b1", 1, 1, T0), bomb("b2", 1, 3, T0 + 100), bomb("b3", 3, 1, T0 + 50)];
  const at = T0 + FUSE_MS + 100;
  const forward = arenaAt(bombs, at);
  const reversed = arenaAt([...bombs].reverse(), at);
  assert.deepEqual([...forward.softBlocks].sort(), [...reversed.softBlocks].sort());
  assert.deepEqual([...forward.blasts.keys()].sort(), [...reversed.blasts.keys()].sort());
  assert.deepEqual(
    forward.detonations.map((item) => [item.id, item.firedAt]).sort(),
    reversed.detonations.map((item) => [item.id, item.firedAt]).sort(),
  );
});

test("two bombs sharing a timestamp still resolve identically", () => {
  const a = [bomb("aaa", 1, 1, T0), bomb("bbb", 1, 3, T0)];
  const at = T0 + FUSE_MS;
  assert.deepEqual(
    arenaAt(a, at).detonations.map((item) => [item.id, item.firedAt]),
    arenaAt([...a].reverse(), at).detonations.map((item) => [item.id, item.firedAt]),
  );
});

test("pruneBombs keeps everything that still affects the present", () => {
  const bombs = [bomb("old", 1, 1, T0 - 60_000), bomb("new", 1, 1, T0)];
  const kept = pruneBombs(bombs, T0);
  assert.deepEqual(kept.map((item) => item.id), ["new"]);
  const state = arenaAt(kept, T0 + FUSE_MS);
  assert.deepEqual(
    [...state.softBlocks].sort(),
    [...arenaAt(bombs, T0 + FUSE_MS).softBlocks].sort(),
    "dropping expired bombs does not change the field",
  );
});
