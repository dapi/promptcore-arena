import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { codexArgs, botDecision } from "../src/agents.mjs";
import { normalizeModels } from "../src/codex-models.mjs";

test("catalog preserves advertised effort order and excludes hidden/invalid models", () => {
  const model = {
    model: "test-model",
    displayName: "Test",
    defaultReasoningEffort: "custom",
    supportedReasoningEfforts: [
      { reasoningEffort: "low" },
      { reasoningEffort: "custom" },
      { reasoningEffort: "high" },
    ],
  };
  const catalog = normalizeModels([
    model,
    { ...model, model: "hidden", hidden: true },
    { ...model, model: "--unsafe" },
  ]);
  assert.equal(catalog.length, 1);
  assert.deepEqual(catalog[0].efforts, ["low", "custom", "high"]);
  assert.equal(catalog[0].defaultReasoning, "custom");
  const args = codexArgs("/tmp/empty", "test-model", "custom");
  assert.equal(args[args.indexOf("--model") + 1], "test-model");
  assert.ok(args.includes('model_reasoning_effort="custom"'));
  assert.ok(!args.includes('model_reasoning_effort="low"'));
});

test("selected model and reasoning reach both agents, persist in series, and reject invalid pairs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-model-test-"));
  const calls = [];
  const catalog = [
    { id: "one", name: "One", efforts: ["low"], defaultReasoning: "low" },
    {
      id: "two",
      name: "Two",
      efforts: ["medium", "high"],
      defaultReasoning: "medium",
    },
  ];
  const app = await createApp({
    dataDir: dir,
    modelCatalog: catalog,
    status: { available: true, model: "one", version: "fixture" },
    provider: async (o, p, m, options) => {
      calls.push({
        id: o.self.id,
        model: options.model,
        reasoning: options.reasoning,
        timeout: options.timeout,
      });
      return botDecision(o, o.self.id === "A" ? "control" : "hunt");
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, data) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const input = {
    mode: "codex",
    seed: "choices",
    prompts: ["a", "b"],
    model: "two",
    reasoning: "high",
    series: true,
  };
  assert.deepEqual(
    (await (await fetch(base + "/api/config")).json()).codex.models,
    catalog,
  );
  assert.equal(
    (await post("/api/run", { ...input, model: "unknown" })).status,
    400,
  );
  assert.equal(
    (await post("/api/run", { ...input, reasoning: "low" })).status,
    400,
  );
  const started = await (await post("/api/run", input)).json();
  let done;
  for (let i = 0; i < 300; i++) {
    done = await (await fetch(base + "/api/jobs/" + started.id)).json();
    if (done.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(done.status, "complete");
  assert.equal(done.matches.length, 4);
  assert.deepEqual([...new Set(calls.map((c) => c.id))].sort(), ["A", "B"]);
  assert.ok(
    calls.every(
      (c) =>
        c.model === "two" && c.reasoning === "high" && c.timeout === 180000,
    ),
  );
  const match = done.matches[0];
  const originalFrames = JSON.stringify(match.frames);
  assert.ok(
    done.matches.every((m) => m.model === "two" && m.reasoning === "high"),
  );
  assert.equal(
    (
      await post(`/api/matches/${match.id}/avatar`, {
        agent: "A",
        avatar: "nope",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(`/api/matches/${match.id}/avatar`, {
        agent: "A",
        avatar: "knight",
      })
    ).status,
    200,
  );
  const saved = JSON.parse(
    await readFile(join(dir, "matches", `${match.id}.json`), "utf8"),
  );
  assert.equal(saved.reasoning, "high");
  assert.equal(saved.fighters[0].avatar, "knight");
  assert.equal(saved.fighters[0].color, "#66d9f2");
  assert.equal(JSON.stringify(saved.frames), originalFrames);
  assert.equal(
    (await (await fetch(base + "/api/matches")).json())[0].reasoning,
    "high",
  );
});

test("catalog failure leaves no invented models and blocks Codex without blocking training", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arena-catalog-test-"));
  let queries = 0;
  const app = await createApp({
    dataDir: dir,
    status: { available: true, model: "preferred-model", version: "fixture" },
    loadModelCatalog: async () => {
      queries++;
      throw Error("offline");
    },
    provider: async () => { throw Error("must not run"); },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    app.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const config = await (await fetch(base + "/api/config")).json();
  assert.equal(queries, 1);
  assert.deepEqual(config.codex.models, []);
  assert.equal(config.codex.model, null);
  assert.equal(config.codex.reasoning, null);
  assert.match(config.codex.catalogNotice, /получить модели/);
  const run = (mode) => fetch(base + "/api/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, seed: "offline", prompts: ["a", "b"] }),
  });
  assert.equal((await run("codex")).status, 503);
  const training = await run("training");
  assert.equal(training.status, 202);
  const job = await training.json();
  for (let i = 0; i < 300; i++) {
    const state = await (await fetch(base + "/api/jobs/" + job.id)).json();
    if (state.status !== "running") {
      assert.equal(state.status, "complete");
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("training did not complete");
});
