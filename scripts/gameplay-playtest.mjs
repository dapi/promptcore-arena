// Diagnostic policies expose incentives. They do not measure LLM strategy quality.
import {
  createState,
  prepareTurn,
  observe,
  resolveTurn,
  equal,
  VERSION,
} from "../src/engine.mjs";
import { botDecision } from "../src/agents.mjs";
const profiles = ["tactician", "hunter", "hold"];
function decide(o, profile) {
  if (profile === "hold")
    return botDecision(
      {
        ...o,
        points: [
          [5, 5],
          [6, 5],
          [5, 6],
          [6, 6],
        ],
        zone: { ...o.zone, nextPoints: null },
        enemies: [],
        batteries: [],
      },
      "control",
    );
  return botDecision(o, profile === "hunter" ? "hunt" : "control");
}
const results = [];
for (let a = 0; a < profiles.length; a++)
  for (let b = a; b < profiles.length; b++)
    for (let seed = 1; seed <= 20; seed++)
      for (const swap of [false, true]) {
        let s = createState(`gameplay-${seed}`, swap);
        const actions = { A: {}, B: {} },
          events = {};
        let stationary = 0,
          sameActions = 0;
        while (!s.result) {
          const p = prepareTurn(s),
            d = {
              A: decide(observe(p, "A"), profiles[a]),
              B: decide(observe(p, "B"), profiles[b]),
            };
          const f = resolveTurn(p, d);
          for (const id of ["A", "B"])
            actions[id][d[id].action] = (actions[id][d[id].action] || 0) + 1;
          for (const e of f.events) events[e.type] = (events[e.type] || 0) + 1;
          stationary += Number(
            f.state.agents.every((x) =>
              equal(x.pos, s.agents.find((y) => y.id === x.id).pos),
            ),
          );
          sameActions += Number(d.A.action === d.B.action);
          s = f.state;
        }
        results.push({
          a: profiles[a],
          b: profiles[b],
          turns: s.turn,
          winner: s.result.winner,
          stationary,
          sameActions,
          actions,
          events,
        });
      }
const summary = [];
for (let a = 0; a < profiles.length; a++)
  for (let b = a; b < profiles.length; b++) {
    const games = results.filter(
      (g) => g.a === profiles[a] && g.b === profiles[b],
    );
    const wins = { A: 0, B: 0, draw: 0 },
      events = {},
      actions = { A: {}, B: {} };
    for (const g of games) {
      wins[g.winner ?? "draw"]++;
      for (const [k, v] of Object.entries(g.events))
        events[k] = (events[k] || 0) + v;
      for (const id of ["A", "B"])
        for (const [k, v] of Object.entries(g.actions[id]))
          actions[id][k] = (actions[id][k] || 0) + v;
    }
    const avg = (k) =>
      +(games.reduce((s, g) => s + g[k], 0) / games.length).toFixed(1);
    summary.push({
      pair: `${profiles[a]} vs ${profiles[b]}`,
      games: games.length,
      ...wins,
      avgTurns: avg("turns"),
      avgBothStationary: avg("stationary"),
      sameActionFraction: +(
        games.reduce((s, g) => s + g.sameActions, 0) /
        games.reduce((s, g) => s + g.turns, 0)
      ).toFixed(2),
      actions,
      events,
    });
  }
console.log(
  JSON.stringify(
    {
      rules: VERSION,
      kind: "algorithmic diagnostic policies, no LLM",
      matches: results.length,
      summary,
    },
    null,
    2,
  ),
);
