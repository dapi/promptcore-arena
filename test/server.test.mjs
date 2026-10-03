import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { botDecision } from "../src/agents.mjs";

test("local API: real engine, replay persistence, series, errors and cancellation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-test-"));
  let behavior = "bot";
  const provider = async (o, _p, _m, { signal }) => {
    if (behavior === "error") throw new Error("Provider test failure");
    if (behavior === "slow")
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    return botDecision(o, o.self.id === "A" ? "control" : "hunt");
  };
  const app = await createApp({
    dataDir: dir,
    status: { available: true, version: "fixture", model: "fixture" },
    provider,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  t.after(async () => {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, data) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const input = {
    mode: "codex",
    seed: "api-test",
    prompts: ["Стратегия A", "Стратегия B"],
  };
  const wait = async (id) => {
    for (let i = 0; i < 300; i++) {
      const j = await (await fetch(`${base}/api/jobs/${id}`)).json();
      if (j.status !== "running") return j;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Job timeout");
  };
  assert.equal((await fetch(base + "/api/config")).status, 200);
  assert.equal(
    await new Promise((resolve) =>
      http.get(base + "/", { headers: { Host: "attacker.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }),
    ),
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/run", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(
    (await post("/api/run", { ...input, prompts: ["one"] })).status,
    400,
  );
  assert.equal((await fetch(base + "/src/server.mjs")).status, 404);
  const first = await (await post("/api/run", input)).json();
  const j = await wait(first.id);
  assert.equal(j.status, "complete");
  assert.equal(j.matches.length, 1);
  assert.ok(j.matches[0].frames.length > 1);
  const file = j.matches[0];
  const replay = await (await fetch(`${base}/api/matches/${file.id}`)).json();
  assert.deepEqual(replay.frames, file.frames);
  assert.equal(replay.prompts[0], input.prompts[0]);
  assert.equal(
    (await readdir(join(dir, "matches"))).filter((x) => x.endsWith(".json"))
      .length,
    1,
  );
  const series = await (
    await post("/api/run", { ...input, series: true })
  ).json();
  const sj = await wait(series.id);
  assert.equal(sj.matches.length, 4);
  assert.deepEqual(
    sj.matches.map((m) => m.swap),
    [false, true, false, true],
  );
  assert.equal(sj.matches[0].seed, sj.matches[1].seed);
  assert.deepEqual(
    sj.matches[0].frames[0].state.walls,
    sj.matches[1].frames[0].state.walls,
  );
  behavior = "error";
  const fail = await (await post("/api/run", input)).json();
  const fj = await wait(fail.id);
  assert.equal(fj.status, "error");
  assert.equal(fj.matches[0].status, "error");
  assert.equal(fj.matches[0].frames.length, 1);
  behavior = "slow";
  const slow = await (await post("/api/run", input)).json();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await post("/api/run", input)).status, 409);
  await post(`/api/jobs/${slow.id}/cancel`, {});
  const cj = await wait(slow.id);
  assert.equal(cj.status, "cancelled");
  assert.equal(cj.matches[0].status, "cancelled");
  const saved = JSON.parse(
    await readFile(join(dir, "matches", `${cj.matches[0].id}.json`), "utf8"),
  );
  assert.equal(saved.status, "cancelled");
});
