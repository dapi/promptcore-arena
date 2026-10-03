import { key, equal, inBounds, clearShot } from "./engine.mjs";

// Only the fighter's observation and its own previously seen walls are inputs.
// Unknown cells are provisionally open; no hidden terrain or enemy state is used.
export function addNavigation(observation, previous = {}) {
  const o = observation;
  const walls = new Map(
    [...(previous?.knownWalls ?? []), ...o.walls].map((p) => [key(p), p]),
  );
  o.knownWalls = [...walls.values()];
  const blocked = new Set([
    ...walls.keys(),
    ...o.enemies.map((a) => key(a.pos)),
    ...o.traps.filter((t) => t.owner !== o.self.id).map((t) => key(t.pos)),
  ]);
  const routes = new Map([
    [key(o.self.pos), { target: o.self.pos, steps: 0, choice: 0 }],
  ]);
  const queue = [o.self.pos];
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i],
      route = routes.get(key(queue[i]));
    for (const p of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (!inBounds(p) || blocked.has(key(p)) || routes.has(key(p))) continue;
      const choice =
        route.steps === 0
          ? o.legalActions.find(
              (d) => d.action === "move" && equal(d.target, p),
            )?.choice
          : route.choice;
      if (choice === undefined) continue;
      routes.set(key(p), { target: p, steps: route.steps + 1, choice });
      queue.push(p);
    }
  }
  const navigation = [];
  const goal = (name, targets) => {
    const route = targets
      .map((p) => routes.get(key(p)))
      .filter(Boolean)
      .sort((a, b) => a.steps - b.steps)[0];
    if (route) navigation.push({ goal: name, ...route });
  };
  goal("zone", o.points);
  if (o.zone?.nextPoints) goal("nextZone", o.zone.nextPoints);
  for (const battery of o.batteries) goal("battery", [battery.pos]);
  for (const enemy of o.enemies) {
    const positions = [...routes.values()].filter((r) =>
      clearShot({ walls: o.knownWalls }, r.target, enemy.pos),
    );
    goal(
      "firingPosition",
      positions.map((r) => r.target),
    );
  }
  o.navigation = navigation;
  return o;
}
