// Shared by the local server, browser and playtest reports. No model calls.
const ids = ["A", "B"];
const integer = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
export function normalizeUsage(raw) {
  const input = integer(raw?.input_tokens),
    output = integer(raw?.output_tokens);
  const cached = integer(raw?.cached_input_tokens);
  const reasoning = integer(raw?.reasoning_output_tokens);
  return {
    input,
    output,
    cached:
      input !== null && cached !== null && cached <= input ? cached : null,
    reasoning:
      output !== null && reasoning !== null && reasoning <= output
        ? reasoning
        : null,
    total: input !== null && output !== null ? input + output : null,
  };
}
export function usageRequests(match) {
  if (Array.isArray(match.requests))
    return match.requests.map((r) =>
      r.status === "pending" && match.status !== "running"
        ? { ...r, status: "interrupted" }
        : r,
    );
  if (match.mode !== "codex") return [];
  // Legacy replays only recorded calls that produced a resolved frame.
  return (match.frames || []).slice(1).flatMap((f) =>
    ids.map((agent) => ({
      id: `${match.id}:${f.state.turn}:${agent}`,
      agent,
      turn: f.state.turn,
      status: "complete",
      rawUsage: f.decisions?.[agent]?.usage ?? null,
    })),
  );
}
export function aggregateUsage(requests) {
  // Each CLI invocation is one ledger row. A repeated snapshot is not a charge.
  const rows = [...new Map(requests.map((r) => [r.id, r])).values()];
  const usage = rows.map((r) => normalizeUsage(r.rawUsage));
  const known = usage.filter((u) => u.total !== null).length;
  const totals = Object.fromEntries(
    ["input", "cached", "output", "reasoning", "total"].map((k) => {
      const values = usage.map((u) => u[k]).filter((v) => v !== null);
      return [
        k,
        values.length || !rows.length
          ? values.reduce((s, v) => s + v, 0)
          : null,
      ];
    }),
  );
  return {
    ...totals,
    requests: rows.length,
    reported: known,
    pending: rows.filter((r) => r.status === "pending").length,
    missing: rows.length - known,
    complete: known === rows.length,
    fieldsReported: Object.fromEntries(
      ["input", "cached", "output", "reasoning"].map((k) => [
        k,
        usage.filter((u) => u[k] !== null).length,
      ]),
    ),
  };
}
export function matchUsage(match) {
  const requests = usageRequests(match);
  const totals = aggregateUsage(requests);
  const legacy = match.mode === "codex" && !Array.isArray(match.requests);
  if (legacy && !requests.length)
    Object.assign(totals, {
      input: null,
      cached: null,
      output: null,
      reasoning: null,
      total: null,
      complete: false,
    });
  return {
    ...totals,
    scope:
      match.mode !== "codex" || Array.isArray(match.requests)
        ? "all_requests"
        : "saved_turns_only",
    fighters: Object.fromEntries(
      ids.map((id) => [
        id,
        legacy && !requests.length
          ? { ...totals, scope: "saved_turns_only" }
          : {
              ...aggregateUsage(requests.filter((r) => r.agent === id)),
              scope: legacy ? "saved_turns_only" : "all_requests",
            },
      ]),
    ),
  };
}
export function analyzeMatch(match) {
  const frames = match.frames || [],
    last = frames.at(-1)?.state;
  const fighters = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        hits: 0,
        misses: 0,
        damage: 0,
        pickups: 0,
        controlTurns: 0,
        invalid: 0,
        collisions: 0,
        waitsOutsideZone: 0,
        stationary: 0,
        actions: {},
      },
    ]),
  );
  const moments = [],
    firstControl = new Set(),
    firstHit = new Set(),
    firstProblem = new Set();
  const add = (frame, kind, actor, text) =>
    moments.push({ frame, turn: frames[frame].state.turn, kind, actor, text });
  let leader = null,
    stationaryTogether = 0;
  for (let i = 1; i < frames.length; i++) {
    const f = frames[i],
      previous = frames[i - 1];
    let stationary = 0;
    for (const id of ids) {
      const stat = fighters[id],
        d = f.decisions?.[id],
        a = f.state.agents.find((a) => a.id === id);
      const before = previous.state.agents.find((a) => a.id === id);
      if (d) stat.actions[d.action] = (stat.actions[d.action] || 0) + 1;
      if (before?.hp > 0 && String(a?.pos) === String(before.pos)) {
        stat.stationary++;
        stationary++;
      }
      if (
        d?.action === "wait" &&
        a?.hp > 0 &&
        !f.state.points.some((p) => String(p) === String(a.pos))
      )
        stat.waitsOutsideZone++;
    }
    if (stationary === 2) stationaryTogether++;
    const health = Object.fromEntries(
      previous.state.agents.map((a) => [a.id, a.hp]),
    );
    for (const e of f.events || []) {
      const stat = fighters[e.actor];
      if (stat) {
        if (e.type === "attack") stat.hits++;
        if (e.type === "miss") stat.misses++;
        if (e.type === "attack" || e.type === "explosion") {
          const damage = Math.min(
            e.damage || 0,
            health[e.target] ?? (e.damage || 0),
          );
          stat.damage += damage;
          if (health[e.target] !== undefined) health[e.target] -= damage;
        }
        if (e.type === "pickup" || e.type === "harvest") stat.pickups++;
        if (e.type === "control") stat.controlTurns++;
        if (e.type === "invalid") stat.invalid++;
        if (e.type === "collision") stat.collisions++;
      }
      if (e.type === "control" && !firstControl.has(e.actor)) {
        firstControl.add(e.actor);
        add(i, e.type, e.actor, "Первый захват зоны");
      }
      if (e.type === "attack" && !firstHit.has(e.actor)) {
        firstHit.add(e.actor);
        add(i, e.type, e.actor, "Первое попадание");
      }
      if (
        ["invalid", "collision"].includes(e.type) &&
        !firstProblem.has(e.actor)
      ) {
        firstProblem.add(e.actor);
        add(
          i,
          e.type,
          e.actor,
          e.type === "invalid" ? "Действие отклонено" : "Первое столкновение",
        );
      }
      if (e.type === "death") add(i, e.type, e.actor, "Боец уничтожен");
      if (e.type === "explosion") add(i, e.type, e.actor, "Сработала ловушка");
    }
    const [a, b] = f.state.agents;
    const nextLeader =
      a.control === b.control ? null : a.control > b.control ? a.id : b.id;
    if (leader && nextLeader && nextLeader !== leader)
      add(i, "lead", nextLeader, "Перехват лидерства по контролю");
    if (nextLeader) leader = nextLeader;
  }
  if (last?.result)
    add(frames.length - 1, "result", last.result.winner, "Итог боя");
  const metric = !last?.result
    ? null
    : last.agents.some((a) => a.hp === 0)
      ? "survival"
      : ["control", "hp", "harvested"].find(
          (key) => last.agents[0][key] !== last.agents[1][key],
        ) || "draw";
  return {
    outcome: last?.result
      ? {
          winner: last.result.winner,
          metric,
          score: last.agents.map(
            (a) => a[metric === "survival" ? "hp" : metric] ?? null,
          ),
        }
      : null,
    turns: Math.max(0, frames.length - 1),
    fighters,
    moments,
    stationaryTogether,
  };
}
export function seriesStats(matches) {
  const complete = matches.filter((m) => m.status === "complete");
  const wins = { A: 0, B: 0, draw: 0 },
    fighters = Object.fromEntries(
      ids.map((id) => [
        id,
        {
          hits: 0,
          misses: 0,
          controlTurns: 0,
          damage: 0,
          invalid: 0,
          collisions: 0,
          waitsOutsideZone: 0,
          actions: {},
        },
      ]),
    );
  for (const m of complete) {
    wins[m.frames.at(-1).state.result.winner || "draw"]++;
    const analysis = analyzeMatch(m);
    for (const id of ids) {
      for (const key of Object.keys(fighters[id]).filter(
        (k) => k !== "actions",
      ))
        fighters[id][key] += analysis.fighters[id][key];
      for (const [action, count] of Object.entries(
        analysis.fighters[id].actions,
      ))
        fighters[id].actions[action] =
          (fighters[id].actions[action] || 0) + count;
    }
  }
  const requests = matches.flatMap(usageRequests);
  const legacy = matches.some(
    (m) => m.mode === "codex" && !Array.isArray(m.requests),
  );
  const usage = aggregateUsage(requests);
  usage.scope = legacy ? "saved_turns_only" : "all_requests";
  if (legacy && !requests.length)
    Object.assign(usage, {
      input: null,
      cached: null,
      output: null,
      reasoning: null,
      total: null,
      complete: false,
    });
  return {
    games: matches.length,
    completed: complete.length,
    wins,
    fighters,
    usage: {
      ...usage,
      fighters: Object.fromEntries(
        ids.map((id) => [
          id,
          aggregateUsage(requests.filter((r) => r.agent === id)),
        ]),
      ),
    },
  };
}
