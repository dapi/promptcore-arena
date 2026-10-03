export const VERSION = "arena/1";
export const SIZE = 12;
export const MAX_TURNS = 40;
export const COST = {
  move: 1,
  scan: 2,
  attack: 3,
  trap: 3,
  defend: 1,
  harvest: 0,
};
export const key = ([x, y]) => `${x},${y}`;
export const equal = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
export const distance = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
export const inBounds = (p) =>
  Array.isArray(p) &&
  p.length === 2 &&
  p.every(Number.isInteger) &&
  p.every((n) => n >= 0 && n < SIZE);
export function random(seed) {
  let n = 2166136261;
  for (const c of String(seed)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return () => {
    n += 0x6d2b79f5;
    let t = Math.imul(n ^ (n >>> 15), 1 | n);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mirror = ([x, y]) => [SIZE - 1 - x, SIZE - 1 - y];
const neighbors = ([x, y]) =>
  [
    [x - 1, y],
    [x + 1, y],
    [x, y - 1],
    [x, y + 1],
  ].filter(inBounds);
function connected(walls) {
  const seen = new Set(["1,1"]),
    queue = [[1, 1]];
  for (let i = 0; i < queue.length; i++)
    for (const p of neighbors(queue[i])) {
      const k = key(p);
      if (!walls.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push(p);
      }
    }
  return seen.size === SIZE * SIZE - walls.size;
}
export function createState(seed = "arena-01", swap = false) {
  const rng = random(seed),
    points = [
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
    ];
  const sources = [
    [2, 2],
    [4, 3],
    [3, 6],
    [2, 8],
  ].flatMap((p) => [p, mirror(p)]);
  const reserved = new Set(
    [
      ...points,
      ...sources,
      [1, 1],
      [10, 10],
      ...neighbors([1, 1]),
      ...neighbors([10, 10]),
    ].map(key),
  );
  const walls = new Set();
  for (let tries = 0; tries < 200 && walls.size < 24; tries++) {
    const p = [Math.floor(rng() * 12), Math.floor(rng() * 12)],
      q = mirror(p);
    if (reserved.has(key(p)) || reserved.has(key(q)) || walls.has(key(p)))
      continue;
    walls.add(key(p));
    walls.add(key(q));
    if (!connected(walls)) {
      walls.delete(key(p));
      walls.delete(key(q));
    }
  }
  return {
    version: VERSION,
    seed: String(seed),
    turn: 0,
    walls: [...walls].map((k) => k.split(",").map(Number)),
    points,
    sources: sources.map((pos) => ({ pos, amount: 12 })),
    traps: [],
    result: null,
    agents: ["A", "B"].map((id, i) => ({
      id,
      pos: i === Number(swap) ? [1, 1] : [10, 10],
      hp: 10,
      energy: 10,
      control: 0,
      harvested: 0,
      scanUntil: 0,
    })),
  };
}
export function prepareTurn(previous) {
  if (previous.result) throw new Error("Матч завершён");
  const s = structuredClone(previous);
  s.turn++;
  for (const a of s.agents)
    if (a.hp > 0 && s.turn > 1) a.energy = Math.min(12, a.energy + 1);
  return s;
}
export function visibility(s, id) {
  const a = s.agents.find((a) => a.id === id),
    radius = a.scanUntil > 0 && a.scanUntil >= s.turn ? 6 : 3,
    cells = [];
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (distance(a.pos, [x, y]) <= radius) cells.push([x, y]);
  return cells;
}
export function observe(s, id) {
  const a = s.agents.find((a) => a.id === id),
    cells = visibility(s, id),
    visible = new Set(cells.map(key));
  return {
    turn: s.turn,
    maxTurns: MAX_TURNS,
    size: SIZE,
    self: structuredClone(a),
    visible: cells,
    walls: s.walls.filter((p) => visible.has(key(p))),
    points: s.points,
    sources: s.sources.filter((v) => visible.has(key(v.pos))),
    traps: s.traps.filter(
      (t) =>
        visible.has(key(t.pos)) &&
        (t.owner === id ||
          distance(t.pos, a.pos) <= 1 ||
          (a.scanUntil > 0 && a.scanUntil >= s.turn)),
    ),
    enemies: s.agents
      .filter((b) => b.id !== id && b.hp > 0 && visible.has(key(b.pos)))
      .map((b) => ({ id: b.id, pos: b.pos, hp: b.hp, energy: b.energy })),
    score: s.agents.map((b) => ({ id: b.id, control: b.control })),
    cost: COST,
  };
}
export function clearShot(s, from, to) {
  if (
    equal(from, to) ||
    (from[0] !== to[0] && from[1] !== to[1]) ||
    distance(from, to) > 3
  )
    return false;
  const dx = Math.sign(to[0] - from[0]),
    dy = Math.sign(to[1] - from[1]);
  for (let p = [from[0] + dx, from[1] + dy]; ; p = [p[0] + dx, p[1] + dy]) {
    if (s.walls.some((w) => equal(w, p))) return false;
    if (equal(p, to)) return true;
  }
}
export function validate(s, a, d) {
  if (!d || !Object.hasOwn(COST, d.action)) return "Неизвестное действие";
  if (a.energy < COST[d.action]) return "Недостаточно энергии";
  if (
    ["move", "attack", "trap", "harvest"].includes(d.action) &&
    !inBounds(d.target)
  )
    return "Неверные координаты";
  const t = d.target;
  if (
    d.action === "move" &&
    (distance(a.pos, t) !== 1 || s.walls.some((w) => equal(w, t)))
  )
    return "Нельзя переместиться";
  if (d.action === "attack" && !clearShot(s, a.pos, t))
    return "Цель вне линии огня";
  if (
    d.action === "trap" &&
    (distance(a.pos, t) !== 1 ||
      s.walls.some((w) => equal(w, t)) ||
      s.points.some((p) => equal(p, t)) ||
      s.sources.some((v) => equal(v.pos, t)) ||
      s.agents.some((b) => b.hp > 0 && equal(b.pos, t)) ||
      s.traps.some((v) => equal(v.pos, t)) ||
      s.traps.filter((v) => v.owner === a.id).length >= 2)
  )
    return "Нельзя установить ловушку";
  if (
    d.action === "harvest" &&
    (distance(a.pos, t) > 1 ||
      !s.sources.some((v) => equal(v.pos, t) && v.amount > 0) ||
      a.energy >= 12)
  )
    return "Источник недоступен или энергия полная";
  return null;
}
export function resolveTurn(prepared, decisions) {
  const s = structuredClone(prepared),
    events = [],
    valid = {},
    defending = new Set();
  const event = (type, actor, text, data = {}) =>
    events.push({ type, actor, text, ...data });
  for (const a of s.agents.filter((a) => a.hp > 0)) {
    const d = decisions[a.id],
      error = validate(prepared, a, d);
    if (error) {
      event("invalid", a.id, `${a.id}: пропуск — ${error}`, { pos: a.pos });
      continue;
    }
    valid[a.id] = d;
    a.energy -= COST[d.action];
    if (d.action === "defend") {
      defending.add(a.id);
      event("defend", a.id, `${a.id} включает щит`, { pos: a.pos });
    }
  }
  const alive = s.agents.filter((a) => a.hp > 0),
    desires = alive.map((a) =>
      valid[a.id]?.action === "move" ? valid[a.id].target : a.pos,
    );
  const collision = alive.length === 2 && equal(desires[0], desires[1]);
  alive.forEach((a, i) => {
    if (valid[a.id]?.action !== "move") return;
    if (collision) {
      event("collision", a.id, `${a.id}: путь занят`, { pos: a.pos });
      return;
    }
    const from = [...a.pos];
    a.pos = [...desires[i]];
    event("move", a.id, `${a.id} → ${a.pos.join(":")}`, { from, to: a.pos });
  });
  const damage = (target, amount, actor, type, from) => {
    const hit = Math.max(0, amount - (defending.has(target.id) ? 2 : 0));
    target.hp = Math.max(0, target.hp - hit);
    event(type, actor, `${actor} → ${target.id}: −${hit} здоровья`, {
      from,
      to: target.pos,
      target: target.id,
      damage: hit,
    });
  };
  for (const t of [...s.traps]) {
    const victim = s.agents.find(
      (a) => a.hp > 0 && a.id !== t.owner && equal(a.pos, t.pos),
    );
    if (victim) {
      damage(victim, 4, t.owner, "explosion", t.pos);
      s.traps = s.traps.filter((v) => v !== t);
    }
  }
  const shooters = s.agents.filter(
    (a) => a.hp > 0 && valid[a.id]?.action === "attack",
  );
  // Snapshot shooters before damage: a lethal simultaneous attack still resolves.
  const shots = shooters.map((a) => ({
    actor: a.id,
    from: [...a.pos],
    to: valid[a.id].target,
    target: s.agents.find(
      (b) => b.id !== a.id && b.hp > 0 && equal(b.pos, valid[a.id].target),
    ),
  }));
  for (const shot of shots) {
    if (shot.target) damage(shot.target, 3, shot.actor, "attack", shot.from);
    else
      event("miss", shot.actor, `${shot.actor}: выстрел мимо`, {
        from: shot.from,
        to: shot.to,
      });
  }
  for (const a of s.agents.filter((a) => a.hp > 0)) {
    const d = valid[a.id];
    if (!d) continue;
    if (d.action === "scan") {
      a.scanUntil = s.turn + 2;
      event("scan", a.id, `${a.id} сканирует сектор`, { pos: a.pos });
    }
    if (d.action === "trap") {
      const conflict = s.agents.some(
        (b) =>
          b.id !== a.id &&
          b.hp > 0 &&
          valid[b.id]?.action === "trap" &&
          equal(valid[b.id].target, d.target),
      );
      if (conflict || s.agents.some((b) => b.hp > 0 && equal(b.pos, d.target)))
        event("collision", a.id, `${a.id}: установка ловушки сорвалась`, {
          pos: d.target,
        });
      else {
        s.traps.push({ owner: a.id, pos: d.target });
        event("trap", a.id, `${a.id} устанавливает ловушку`, { pos: d.target });
      }
    }
  }
  for (const source of s.sources) {
    const takers = s.agents.filter(
      (a) =>
        a.hp > 0 &&
        valid[a.id]?.action === "harvest" &&
        equal(valid[a.id].target, source.pos),
    );
    const share = takers.length
      ? Math.min(4, Math.floor(source.amount / takers.length))
      : 0;
    for (const a of takers) {
      const amount = Math.min(share, 12 - a.energy);
      a.energy += amount;
      a.harvested += amount;
      source.amount -= amount;
      event("harvest", a.id, `${a.id}: +${amount} энергии`, {
        pos: source.pos,
        to: a.pos,
        amount,
      });
    }
    source.amount = Math.min(12, source.amount + 1);
  }
  for (const a of s.agents) {
    if (a.hp > 0 && s.points.some((p) => equal(p, a.pos))) {
      a.control++;
      event("control", a.id, `${a.id} удерживает ядро · ${a.control}`, {
        pos: a.pos,
      });
    }
    if (a.hp === 0 && prepared.agents.find((b) => b.id === a.id).hp > 0)
      event("death", a.id, `${a.id} уничтожен`, { pos: a.pos });
  }
  const survivors = s.agents.filter((a) => a.hp > 0);
  if (survivors.length < 2)
    s.result = {
      winner: survivors[0]?.id ?? null,
      reason: survivors.length ? "Последний выживший" : "Взаимное уничтожение",
    };
  else if (s.turn >= MAX_TURNS) {
    const [a, b] = survivors;
    let winner = null;
    for (const stat of ["control", "hp", "harvested"])
      if (a[stat] !== b[stat]) {
        winner = a[stat] > b[stat] ? a.id : b.id;
        break;
      }
    s.result = {
      winner,
      reason: winner
        ? "По контролю, здоровью и энергии"
        : "Равенство показателей",
    };
  }
  return { state: s, events };
}
