import test from "node:test";
import assert from "node:assert/strict";
import {
  createState,
  prepareTurn,
  observe,
  resolveTurn,
  equal,
} from "../src/engine.mjs";
import { addNavigation } from "../src/navigation.mjs";

test("navigation escapes the Luna pilot's dead end and reaches moving zones", () => {
  let state = createState("arena-v2-check"),
    previous;
  state.agents[0].pos = [2, 3];
  for (let turn = 0; turn < 30; turn++) {
    const prepared = prepareTurn(state);
    const o = addNavigation(observe(prepared, "A"), previous);
    const route = o.navigation.find((n) => n.goal === "zone");
    assert.ok(route);
    const decision = o.legalActions.find((d) => d.choice === route.choice);
    if (turn === 0) assert.deepEqual(decision.target, [2, 2]);
    const frame = resolveTurn(prepared, { A: decision, B: { action: "wait" } });
    assert.ok(!frame.events.some((e) => e.type === "invalid"));
    state = frame.state;
    previous = o;
  }
  assert.ok(state.agents[0].control > 5, "must get out of pocket and score");
});

test("navigation remembers observed walls without revealing hidden terrain or enemies", () => {
  const state = prepareTurn(createState("navigation-fog"));
  const original = observe(state, "A");
  const unseen = state.walls.find(
    (p) => !original.visible.some((v) => equal(v, p)),
  );
  assert.ok(unseen);
  const o = addNavigation(structuredClone(original));
  assert.ok(!o.knownWalls.some((p) => equal(p, unseen)));
  assert.ok(!o.navigation.some((n) => n.goal === "firingPosition"));
  const next = addNavigation({ ...structuredClone(original), walls: [] }, o);
  assert.deepEqual(next.knownWalls, o.knownWalls);
  assert.deepEqual(next.navigation, o.navigation);
  const before = structuredClone(o);
  addNavigation(structuredClone(original), o);
  assert.deepEqual(o, before, "previous frames remain immutable");
});
