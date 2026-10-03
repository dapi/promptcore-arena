import test from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  prepareTurn,
  resolveTurn,
  observe,
  validate,
  key,
  VERSION,
} from "../src/engine.mjs";
import * as legacy from "../src/engine-v1.mjs";
import { botDecision } from "../src/agents.mjs";
const choice = (action, target = null) => ({ action, target, reason: "test" });
const step = (s, A = choice("wait"), B = choice("wait")) =>
  resolveTurn(prepareTurn(s), { A, B });
const arena = () => {
  const s = createState("v2-test");
  s.walls = [];
  s.batteries = [];
  s.traps = [];
  s.agents[0].pos = [4, 5];
  s.agents[1].pos = [8, 5];
  return s;
};
test("v2 seeded maps, battery pairs and all future zones stay reachable; swap preserves layout", () => {
  const layouts = new Set();
  for (let i = 0; i < 30; i++) {
    let s = createState(String(i)),
      swapped = createState(String(i), true);
    assert.equal(s.version, VERSION);
    assert.deepEqual(s.walls, swapped.walls);
    assert.deepEqual(s.batteries, swapped.batteries);
    assert.deepEqual(s.agents[0].pos, swapped.agents[1].pos);
    const walls = new Set(s.walls.map(key));
    for (const [x, y] of s.walls) assert.ok(walls.has(`${11 - x},${11 - y}`));
    const visited = new Set(["1,1"]),
      queue = [[1, 1]];
    for (let j = 0; j < queue.length; j++) {
      const [x, y] = queue[j];
      for (const p of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ])
        if (
          p.every((n) => n >= 0 && n < 12) &&
          !walls.has(key(p)) &&
          !visited.has(key(p))
        ) {
          visited.add(key(p));
          queue.push(p);
        }
    }
    assert.equal(visited.size, 144 - s.walls.length);
    layouts.add(JSON.stringify(s.batteries));
    while (!s.result) {
      const p = prepareTurn(s);
      assert.deepEqual(p, prepareTurn(s));
      for (const cell of [...p.points, ...(p.zone.nextPoints ?? [])])
        assert.ok(!walls.has(key(cell)));
      for (const battery of p.batteries) {
        assert.ok(visited.has(key(battery.pos)));
        assert.ok(
          p.batteries.some(
            (b) =>
              b.pos[0] + battery.pos[0] === 11 &&
              b.pos[1] + battery.pos[1] === 11,
          ),
        );
      }
      s = resolveTurn(p, { A: choice("wait"), B: choice("wait") }).state;
    }
  }
  assert.ok(layouts.size > 1);
});
test("entry collects and removes battery, clamps energy, counts only gained energy", () => {
  for (const initial of [0, 10, 12]) {
    const s = arena();
    s.agents[0].energy = initial;
    s.batteries = [{ pos: [5, 5], amount: 4 }];
    const f = step(s, choice("move", [5, 5]));
    assert.equal(f.state.agents[0].energy, Math.min(12, initial + 4));
    assert.equal(f.state.agents[0].harvested, Math.min(4, 12 - initial));
    assert.equal(f.state.batteries.length, 0);
    assert.equal(f.events.filter((e) => e.type === "pickup").length, 1);
    assert.equal(s.batteries.length, 1);
  }
});
test("adjacency, waiting, collisions and fatal damage do not collect a battery", () => {
  const s = arena();
  s.batteries = [{ pos: [5, 5], amount: 4 }];
  s.agents[1].pos = [6, 5];
  let f = step(s);
  assert.equal(f.state.batteries.length, 1);
  f = step(s, choice("move", [5, 5]), choice("move", [5, 5]));
  assert.equal(f.state.batteries.length, 1);
  assert.equal(f.state.agents[0].energy, 6);
  s.traps = [{ pos: [5, 5], owner: "B" }];
  s.agents[0].hp = 4;
  f = step(s, choice("move", [5, 5]));
  assert.equal(f.state.agents[0].hp, 0);
  assert.equal(f.state.batteries.length, 1);
});
test("movement and waiting work at zero energy; no passive charge or harvest action", () => {
  let s = arena();
  s.turn = 2;
  s.agents[0].energy = 0;
  let f = step(s, choice("move", [4, 4]));
  assert.deepEqual(f.state.agents[0].pos, [4, 4]);
  assert.equal(f.state.agents[0].energy, 0);
  s = f.state;
  f = step(s);
  assert.equal(f.state.agents[0].energy, 0);
  assert.ok(validate(s, s.agents[0], choice("attack", [8, 5])));
  assert.ok(validate(s, s.agents[0], choice("harvest", [4, 4])));
});
test("battery waves are deterministic, replace leftovers and never spawn under fighters or traps", () => {
  const s = arena();
  s.turn = 6;
  s.batteries = [{ pos: [0, 0], amount: 4 }];
  s.traps = [{ pos: [3, 4], owner: "A" }];
  const p = prepareTurn(s);
  assert.equal(p.batteries.length, 8);
  assert.deepEqual(p.batteries, prepareTurn(s).batteries);
  for (const b of p.batteries) {
    assert.notDeepEqual(b.pos, [0, 0]);
    assert.ok(!p.agents.some((a) => key(a.pos) === key(b.pos)));
    assert.ok(!p.traps.some((t) => key(t.pos) === key(b.pos)));
  }
  assert.ok(
    resolveTurn(p, { A: choice("wait"), B: choice("wait") }).events.some(
      (e) => e.type === "battery_wave",
    ),
  );
});
test("zone announces two turns ahead, changes on turn nine and stops old-zone scoring", () => {
  const s = arena();
  s.turn = 5;
  assert.equal(observe(prepareTurn(s), "A").zone.nextPoints, null);
  s.turn = 6;
  const early = prepareTurn(s);
  assert.deepEqual(observe(early, "A").zone.nextPoints, early.zone.nextPoints);
  s.turn = 8;
  s.agents[0].pos = [5, 5];
  const f = step(s);
  assert.notDeepEqual(f.state.points, s.points);
  assert.equal(f.state.zone.endsAt, 16);
  assert.equal(f.state.agents[0].control, 0);
  assert.ok(f.events.some((e) => e.type === "zone_shift"));
});
test("only a sole surviving occupant scores, contest gives neither points", () => {
  const s = arena();
  s.agents[0].pos = [5, 5];
  s.agents[1].pos = [6, 5];
  let f = step(s);
  assert.deepEqual(
    f.state.agents.map((a) => a.control),
    [0, 0],
  );
  assert.ok(f.events.some((e) => e.type === "contested"));
  f = step(s, choice("wait"), choice("move", [7, 5]));
  assert.deepEqual(
    f.state.agents.map((a) => a.control),
    [1, 0],
  );
  s.agents[1].hp = 3;
  f = step(s, choice("attack", [6, 5]));
  assert.equal(f.state.result.winner, "A");
  assert.equal(f.state.agents[0].control, 1);
});
test("v1 states still reproduce through version dispatch with their original energy and collection rules", () => {
  let s = legacy.createState("archive-check");
  for (let i = 0; i < 12; i++) {
    const prepared = prepareTurn(s);
    assert.deepEqual(prepared, legacy.prepareTurn(s));
    assert.deepEqual(observe(prepared, "A"), legacy.observe(prepared, "A"));
    const decisions = {
      A: botDecision(legacy.observe(prepared, "A")),
      B: botDecision(legacy.observe(prepared, "B"), "hunt"),
    };
    const frame = resolveTurn(prepared, decisions);
    assert.deepEqual(frame, legacy.resolveTurn(prepared, decisions));
    s = frame.state;
    if (s.result) break;
  }
});
test("v2 training styles make different choices and complete replayable matches without invalid actions", () => {
  const o = observe(
    prepareTurn({
      ...arena(),
      agents: arena().agents.map((a) =>
        a.id === "A" ? { ...a, pos: [5, 5] } : a,
      ),
    }),
    "A",
  );
  assert.notEqual(
    botDecision(o, "control").action,
    botDecision(o, "hunt").action,
  );
  for (const seed of ["sector-07", "gameplay-2", "gameplay-3"]) {
    let s = createState(seed);
    const records = [];
    while (!s.result) {
      const p = prepareTurn(s),
        d = {
          A: botDecision(observe(p, "A"), "control"),
          B: botDecision(observe(p, "B"), "hunt"),
        };
      const f = resolveTurn(p, d);
      assert.ok(!f.events.some((e) => e.type === "invalid"));
      assert.ok(f.state.agents.every((a) => a.energy >= 0 && a.energy <= 12));
      records.push({ d, state: f.state });
      s = f.state;
    }
    let replay = createState(seed);
    for (const r of records) {
      replay = resolveTurn(prepareTurn(replay), r.d).state;
      assert.deepEqual(replay, r.state);
    }
    assert.ok(s.turn <= 40);
  }
});

test("advertised legal choices exclude walls, long jumps and unaffordable actions", () => {
  const s = arena();
  s.walls = [[4, 4]];
  s.agents[0].energy = 0;
  const p = prepareTurn(s),
    o = observe(p, "A");
  assert.ok(o.legalActions.length > 0);
  for (const d of o.legalActions) {
    assert.equal(validate(p, p.agents[0], d), null);
    assert.ok(["move", "wait"].includes(d.action));
  }
  assert.ok(
    !o.legalActions.some((d) => d.action === "move" && key(d.target) === "4,4"),
  );
  assert.ok(
    !o.legalActions.some((d) => d.action === "move" && key(d.target) === "4,7"),
  );
  const hidden = structuredClone(p);
  hidden.agents[1].pos = [11, 11];
  assert.deepEqual(
    observe(p, "A").legalActions,
    observe(hidden, "A").legalActions,
  );
});
