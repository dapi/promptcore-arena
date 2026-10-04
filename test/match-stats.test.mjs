import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateUsage,
  normalizeUsage,
  matchUsage,
  analyzeMatch,
  seriesStats,
} from "../web/match-stats.js";

const raw = {
  input_tokens: 100,
  cached_input_tokens: 60,
  output_tokens: 20,
  reasoning_output_tokens: 12,
  cache_write_input_tokens: 0,
};
test("usage totals do not double count cached input, reasoning or repeated request snapshots", () => {
  const request = {
    id: "request-1",
    agent: "A",
    status: "complete",
    rawUsage: raw,
  };
  assert.deepEqual(normalizeUsage(raw), {
    input: 100,
    cached: 60,
    output: 20,
    reasoning: 12,
    total: 120,
  });
  const total = aggregateUsage([
    { ...request, rawUsage: null },
    request,
    request,
  ]);
  assert.equal(total.requests, 1);
  assert.equal(total.total, 120);
  assert.equal(total.complete, true);
  assert.equal(total.fieldsReported.reasoning, 1);
});
test("unknown is different from zero; invalid counters and absent optional fields stay unknown", () => {
  const total = aggregateUsage([
    { id: "known", rawUsage: raw, status: "complete" },
    { id: "error", rawUsage: null, status: "error" },
    { id: "pending", rawUsage: null, status: "pending" },
  ]);
  assert.equal(total.total, 120);
  assert.equal(total.missing, 2);
  assert.equal(total.pending, 1);
  assert.equal(total.complete, false);
  assert.equal(aggregateUsage([{ id: "empty" }]).total, null);
  assert.equal(
    aggregateUsage([
      { id: "zero", rawUsage: { input_tokens: 0, output_tokens: 0 } },
    ]).total,
    0,
  );
  assert.equal(
    normalizeUsage({ input_tokens: -1, output_tokens: "10" }).total,
    null,
  );
  assert.equal(
    normalizeUsage({ ...raw, cached_input_tokens: 101 }).cached,
    null,
  );
  assert.equal(
    normalizeUsage({ ...raw, reasoning_output_tokens: 21 }).reasoning,
    null,
  );
  assert.equal(
    normalizeUsage({ input_tokens: 1, output_tokens: 2 }).reasoning,
    null,
  );
});
test("old replays remain readable, training uses zero tokens, interrupted calls are not still pending", () => {
  const legacy = {
    id: "old",
    mode: "codex",
    status: "complete",
    frames: [
      { state: { turn: 0 } },
      { state: { turn: 1 }, decisions: { A: { usage: raw }, B: {} } },
    ],
  };
  assert.equal(matchUsage(legacy).scope, "saved_turns_only");
  assert.equal(matchUsage(legacy).total, 120);
  assert.equal(matchUsage(legacy).fighters.B.total, null);
  assert.equal(matchUsage({ mode: "training" }).total, 0);
  assert.equal(
    seriesStats([{ mode: "codex", status: "cancelled", frames: [] }]).usage
      .total,
    null,
  );
  assert.equal(
    matchUsage({ mode: "codex", status: "cancelled", frames: [] }).total,
    null,
  );
  const interrupted = matchUsage({
    mode: "codex",
    status: "interrupted",
    requests: [{ id: "a", agent: "A", status: "pending" }],
  });
  assert.equal(interrupted.pending, 0);
  assert.equal(interrupted.missing, 1);
});
const state = (turn, a, b, result = null) => ({
  turn,
  points: [[1, 1]],
  result,
  agents: [
    { id: "A", hp: 10, pos: [0, 0], control: a },
    { id: "B", hp: 10, pos: [1, 1], control: b },
  ],
});
test("damage measures health removed, excluding overkill", () => {
  const before = state(0, 0, 0),
    after = state(1, 0, 0, { winner: "B" });
  before.agents[0].hp = 2;
  after.agents[0].hp = 0;
  const stats = analyzeMatch({
    frames: [
      { state: before },
      {
        state: after,
        events: [{ type: "attack", actor: "B", target: "A", damage: 3 }],
      },
    ],
  });
  assert.equal(stats.fighters.B.damage, 2);
  assert.equal(stats.fighters.B.hits, 1);
});
test("battle analysis counts resolved events and distinguishes waiting from stationary combat", () => {
  const match = {
    status: "complete",
    mode: "training",
    frames: [
      { state: state(0, 0, 0) },
      {
        state: state(1, 0, 1),
        decisions: { A: { action: "attack" }, B: { action: "wait" } },
        events: [
          { type: "miss", actor: "A" },
          { type: "control", actor: "B" },
        ],
      },
      {
        state: state(2, 0, 2),
        decisions: { A: { action: "wait" }, B: { action: "attack" } },
        events: [
          { type: "attack", actor: "B", damage: 3 },
          { type: "control", actor: "B" },
          { type: "collision", actor: "A" },
          { type: "invalid", actor: "A" },
        ],
      },
      {
        state: state(3, 0, 3, { winner: "B" }),
        decisions: { A: { action: "defend" }, B: { action: "attack" } },
        events: [
          { type: "attack", actor: "B", damage: 1 },
          { type: "control", actor: "B" },
        ],
      },
    ],
  };
  const stats = analyzeMatch(match);
  assert.equal(stats.outcome.metric, "control");
  assert.equal(stats.fighters.A.waitsOutsideZone, 1);
  assert.equal(stats.fighters.B.waitsOutsideZone, 0);
  assert.equal(stats.fighters.B.controlTurns, 3);
  assert.equal(stats.fighters.B.hits, 2);
  assert.equal(stats.fighters.B.damage, 4);
  assert.equal(stats.fighters.A.misses, 1);
  assert.equal(stats.fighters.A.collisions, 1);
  assert.equal(stats.fighters.A.invalid, 1);
  assert.deepEqual(
    stats.moments.map((m) => [m.frame, m.kind]),
    [
      [1, "control"],
      [2, "attack"],
      [2, "collision"],
      [3, "result"],
    ],
  );
  assert.equal(
    seriesStats([match, { ...match, status: "cancelled" }]).wins.B,
    1,
  );
  assert.equal(
    seriesStats([match, { ...match, status: "cancelled" }]).fighters.B.hits,
    2,
  );
});
