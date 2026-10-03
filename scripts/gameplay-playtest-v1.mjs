// Diagnostic policies for game-design playtests. They are not LLM substitutes.
import { createState, prepareTurn, observe, resolveTurn, clearShot, distance, equal, inBounds, key } from "../src/engine-v1.mjs";

const profiles = ["hold", "hunt", "scout", "trap", "harvest"];
const point = (o) => o.points.some((p) => equal(p, o.self.pos));
const choice = (action, target = null) => ({ action, target, reason: "Диагностическая стратегия", memory: "" });
function route(o, goals) {
  const walls = new Set(o.walls.map(key));
  const occupied = new Set(o.enemies.map((e) => key(e.pos)));
  const queue = [{ pos: o.self.pos, first: null }];
  const seen = new Set([key(o.self.pos)]);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.first && goals.some((p) => equal(p, n.pos))) return n.first;
    const [x, y] = n.pos;
    for (const p of [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]]) {
      const k = key(p);
      if (!inBounds(p) || walls.has(k) || occupied.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push({ pos: p, first: n.first ?? p });
    }
  }
  return null;
}
function decide(o, profile) {
  const enemy = o.enemies[0];
  if (profile !== "hold" && enemy && o.self.energy >= 3 && clearShot({ walls: o.walls }, o.self.pos, enemy.pos))
    return choice("attack", enemy.pos);
  if (profile === "harvest" && o.self.harvested < 8 && o.self.energy < 12) {
    const source = o.sources.filter((s) => s.amount > 0).sort((a, b) => distance(o.self.pos, a.pos) - distance(o.self.pos, b.pos))[0];
    if (source && distance(o.self.pos, source.pos) <= 1 && o.self.energy < 12)
      return choice("harvest", source.pos);
    if (source) {
      const adjacent = [source.pos, [source.pos[0] + 1, source.pos[1]], [source.pos[0] - 1, source.pos[1]], [source.pos[0], source.pos[1] + 1], [source.pos[0], source.pos[1] - 1]].filter(inBounds);
      const next = route(o, adjacent);
      if (next) return choice("move", next);
    }
  }
  if (profile === "hunt" && enemy) {
    const around = [[enemy.pos[0] + 1, enemy.pos[1]], [enemy.pos[0] - 1, enemy.pos[1]], [enemy.pos[0], enemy.pos[1] + 1], [enemy.pos[0], enemy.pos[1] - 1]].filter(inBounds);
    const next = route(o, around);
    if (next) return choice("move", next);
  }
  if (profile === "scout" && !enemy && !point(o) && o.self.energy >= 2 && o.turn % 3 === 1)
    return choice("scan");
  if (point(o)) {
    if (profile === "trap" && o.self.energy >= 3 && o.traps.filter((t) => t.owner === o.self.id).length < 2) {
      const [x, y] = o.self.pos;
      const forbidden = new Set([...o.walls, ...o.points, ...o.sources.map((s) => s.pos), ...o.traps.map((t) => t.pos), ...o.enemies.map((e) => e.pos)].map(key));
      const cell = [[x + 1, y], [x, y + 1], [x - 1, y], [x, y - 1]].find((p) => inBounds(p) && !forbidden.has(key(p)));
      if (cell) return choice("trap", cell);
    }
    return choice("defend");
  }
  const next = route(o, o.points);
  return next ? choice("move", next) : choice("defend");
}

const seeds = Array.from({ length: 20 }, (_, i) => `gameplay-${i + 1}`);
const results = [];
for (let i = 0; i < profiles.length; i++)
  for (let j = i; j < profiles.length; j++)
    for (const seed of seeds)
      for (const swap of [false, true]) {
        let state = createState(seed, swap);
        const actionTypes = {};
        const eventTypes = {};
        let immobileBoth = 0;
        let turnsOnCenterTogether = 0;
        while (!state.result) {
          const prepared = prepareTurn(state);
          const decisions = {
            A: decide(observe(prepared, "A"), profiles[i]),
            B: decide(observe(prepared, "B"), profiles[j]),
          };
          for (const d of Object.values(decisions)) actionTypes[d.action] = (actionTypes[d.action] ?? 0) + 1;
          const frame = resolveTurn(prepared, decisions);
          for (const e of frame.events) eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
          const next = frame.state;
          if (next.agents.every((a, n) => equal(a.pos, state.agents[n].pos))) immobileBoth++;
          if (next.agents.every((a) => next.points.some((p) => equal(p, a.pos)))) turnsOnCenterTogether++;
          state = next;
        }
        results.push({ a: profiles[i], b: profiles[j], seed, swap, winner: state.result.winner, reason: state.result.reason, turns: state.turn, immobileBoth, turnsOnCenterTogether, control: state.agents.map((a) => a.control), hp: state.agents.map((a) => a.hp), actionTypes, eventTypes });
      }
const summary = [];
for (let i = 0; i < profiles.length; i++)
  for (let j = i; j < profiles.length; j++) {
    const games = results.filter((r) => r.a === profiles[i] && r.b === profiles[j]);
    const counts = { A: 0, B: 0, draw: 0 };
    const acts = {};
    const events = {};
    const reasons = {};
    for (const g of games) {
      counts[g.winner ?? "draw"]++;
      reasons[g.reason] = (reasons[g.reason] ?? 0) + 1;
      for (const [k, v] of Object.entries(g.actionTypes)) acts[k] = (acts[k] ?? 0) + v;
      for (const [k, v] of Object.entries(g.eventTypes)) events[k] = (events[k] ?? 0) + v;
    }
    summary.push({ pair: `${profiles[i]} vs ${profiles[j]}`, games: games.length, ...counts, avgTurns: +(games.reduce((v, g) => v + g.turns, 0) / games.length).toFixed(1), avgBothImmobile: +(games.reduce((v, g) => v + g.immobileBoth, 0) / games.length).toFixed(1), avgTogetherOnCenter: +(games.reduce((v, g) => v + g.turnsOnCenterTogether, 0) / games.length).toFixed(1), reasons, actions: acts, events });
  }
console.log(JSON.stringify({ rules: "arena/1", kind: "algorithmic diagnostic policies, no LLM", seeds: seeds.length, matches: results.length, summary }, null, 2));
