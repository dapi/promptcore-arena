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
  visibility,
} from "../src/engine.mjs";
import { botDecision, codexArgs } from "../src/agents.mjs";
const action = (action, target = null) => ({ action, target, reason: "test" });
const arena = () => {
  const s = createState("test");
  s.walls = [];
  s.traps = [];
  s.agents[0].pos = [4, 5];
  s.agents[1].pos = [6, 5];
  return s;
};
function step(s, A, B) {
  return resolveTurn(prepareTurn(s), { A, B });
}

test("seed generates symmetric connected maps and seat swap preserves map", () => {
  for (let seed = 0; seed < 40; seed++) {
    const a = createState(String(seed)),
      b = createState(String(seed), true);
    assert.deepEqual(a.walls, b.walls);
    assert.deepEqual(a.sources, b.sources);
    assert.deepEqual(a.agents[0].pos, b.agents[1].pos);
    assert.equal(a.version, VERSION);
    const wall = new Set(a.walls.map(key));
    for (const [x, y] of a.walls) assert.ok(wall.has(`${11 - x},${11 - y}`));
    const seen = new Set(["1,1"]),
      q = [[1, 1]];
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      for (const p of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ])
        if (
          p.every((n) => n >= 0 && n < 12) &&
          !wall.has(key(p)) &&
          !seen.has(key(p))
        ) {
          seen.add(key(p));
          q.push(p);
        }
    }
    assert.equal(seen.size, 144 - a.walls.length);
  }
});
test("same target collision spends energy without creating overlapping agents", () => {
  const s = arena();
  const f = step(s, action("move", [5, 5]), action("move", [5, 5]));
  assert.deepEqual(
    f.state.agents.map((a) => a.pos),
    [
      [4, 5],
      [6, 5],
    ],
  );
  assert.equal(f.state.agents[0].energy, 9);
  assert.equal(f.events.filter((e) => e.type === "collision").length, 2);
});
test("position exchange is allowed but moving into a stationary agent is blocked", () => {
  const s = arena();
  s.agents[1].pos = [5, 5];
  let f = step(s, action("move", [5, 5]), action("move", [4, 5]));
  assert.deepEqual(
    f.state.agents.map((a) => a.pos),
    [
      [5, 5],
      [4, 5],
    ],
  );
  f = step(s, action("move", [5, 5]), action("defend"));
  assert.deepEqual(f.state.agents[0].pos, [4, 5]);
});
test("simultaneous lethal shots produce draw independent of order", () => {
  const s = arena();
  s.agents.forEach((a) => (a.hp = 3));
  const f = step(s, action("attack", [6, 5]), action("attack", [4, 5]));
  assert.deepEqual(
    f.state.agents.map((a) => a.hp),
    [0, 0],
  );
  assert.equal(f.state.result.winner, null);
  assert.equal(f.state.result.reason, "Взаимное уничтожение");
});
test("defend reduces damage on the same turn", () => {
  const s = arena();
  const f = step(s, action("attack", [6, 5]), action("defend"));
  assert.equal(f.state.agents[1].hp, 9);
});
test("attacks target cells after movement and can miss", () => {
  const s = arena();
  const f = step(s, action("attack", [6, 5]), action("move", [6, 6]));
  assert.equal(f.state.agents[1].hp, 10);
  assert.ok(f.events.some((e) => e.type === "miss"));
});
test("walls block shots; invalid and malformed actions cost nothing", () => {
  const s = arena();
  s.walls = [[5, 5]];
  const f = step(s, action("attack", [6, 5]), {
    action: "move",
    target: [NaN, 1],
  });
  assert.deepEqual(
    f.state.agents.map((a) => a.energy),
    [10, 10],
  );
  assert.equal(f.events.filter((e) => e.type === "invalid").length, 2);
  assert.ok(validate(s, s.agents[0], { action: "__proto__" }));
});
test("enemy trap triggers once, owner passes safely", () => {
  const s = arena();
  s.traps = [{ owner: "A", pos: [5, 5] }];
  let f = step(s, action("defend"), action("move", [5, 5]));
  assert.equal(f.state.agents[1].hp, 6);
  assert.equal(f.state.traps.length, 0);
  f = step(s, action("move", [5, 5]), action("defend"));
  assert.equal(f.state.agents[0].hp, 10);
  assert.equal(f.state.traps.length, 1);
});
test("shared scarce energy is divided evenly; no iteration advantage", () => {
  const s = arena();
  s.sources = [{ pos: [5, 5], amount: 3 }];
  s.agents.forEach((a) => (a.energy = 2));
  const f = step(s, action("harvest", [5, 5]), action("harvest", [5, 5]));
  assert.deepEqual(
    f.state.agents.map((a) => a.harvested),
    [1, 1],
  );
  assert.equal(f.state.sources[0].amount, 2);
});
test("initial visibility uses the normal radius", () => {
  const s = arena();
  assert.equal(
    visibility(s, "A").some((p) => p[0] === 8 && p[1] === 5),
    false,
  );
});
test("fog hides enemy position and traps; scan expires after two observations", () => {
  const s = arena();
  s.agents[1].pos = [9, 5];
  s.traps = [{ owner: "B", pos: [6, 5] }];
  const o = observe(prepareTurn(s), "A");
  assert.equal(o.enemies.length, 0);
  assert.equal(o.traps.length, 0);
  const f = step(s, action("scan"), action("defend"));
  let t = prepareTurn(f.state);
  assert.equal(observe(t, "A").enemies.length, 1);
  assert.equal(observe(t, "A").traps.length, 1);
  t.turn = 4;
  assert.equal(observe(t, "A").enemies.length, 0);
  assert.equal(observe(t, "A").traps.length, 0);
  assert.equal("prompts" in o, false);
});
test("control beats health at turn 40 and energy recovers without harvest", () => {
  const s = arena();
  s.turn = 39;
  s.agents[0].control = 3;
  s.agents[0].hp = 1;
  s.agents[0].energy = 0;
  s.agents[1].pos = [10, 10];
  const f = step(s, action("defend"), action("defend"));
  assert.equal(f.state.result.winner, "A");
  assert.equal(f.state.agents[0].energy, 0);
});
test("full bot matches terminate and recorded decisions replay exactly", () => {
  for (const seed of ["sector-07", "replay-2", "replay-3"]) {
    let s = createState(seed),
      r = createState(seed),
      turns = 0;
    while (!s.result) {
      const p = prepareTurn(s),
        d = Object.fromEntries(
          ["A", "B"].map((id, i) => [
            id,
            botDecision(observe(p, id), i ? "hunt" : "control"),
          ]),
        );
      const f = resolveTurn(p, d);
      s = f.state;
      r = resolveTurn(prepareTurn(r), d).state;
      assert.deepEqual(s, r);
      assert.ok(
        s.agents.every((a) => a.hp >= 0 && a.energy >= 0 && a.energy <= 12),
      );
      assert.notDeepEqual(s.agents[0].pos, s.agents[1].pos);
      assert.ok(++turns <= 40);
    }
  }
});
test("Codex adapter excludes user configuration and tool features", () => {
  const a = codexArgs("/tmp/empty", "example-model");
  assert.ok(a.includes("--ignore-user-config"));
  assert.ok(a.includes("--ephemeral"));
  assert.ok(a.includes("read-only"));
  assert.ok(a.includes("project_doc_max_bytes=0"));
  for (const feature of [
    "shell_tool",
    "hooks",
    "plugins",
    "multi_agent",
    "browser_use",
    "computer_use",
  ])
    assert.equal(a[a.indexOf(feature) - 1], "--disable");
});
