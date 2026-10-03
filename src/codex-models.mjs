import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { jsonLines } from "./codex-events.mjs";

export function normalizeModels(entries) {
  const models = new Map();
  for (const m of entries || []) {
    if (
      !m ||
      m.hidden ||
      typeof m.model !== "string" ||
      !/^[a-z0-9][a-z0-9._:/-]{0,99}$/i.test(m.model)
    ) continue;
    const efforts = [
      ...new Set(
        (m.supportedReasoningEfforts || [])
          .map((e) => e.reasoningEffort)
          .filter(
            (e) => typeof e === "string" && /^[a-z][a-z0-9_-]{0,30}$/.test(e),
          ),
      ),
    ];
    if (!efforts.length) continue;
    models.set(m.model, {
      id: m.model,
      name: typeof m.displayName === "string" ? m.displayName : m.model,
      efforts,
      defaultReasoning: efforts.includes(m.defaultReasoningEffort)
        ? m.defaultReasoningEffort
        : efforts[0],
    });
  }
  return [...models.values()];
}

// Read the account's picker catalog without starting a thread or an inference.
export function discoverModels({ timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "app-server",
        "--stdio",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "--disable",
        "apps",
        "-c",
        "analytics.enabled=false",
      ],
      { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] },
    );
    let settled = false,
      bytes = 0,
      nextId = 2;
    const entries = [],
      cursors = new Set();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(Error("Не удалось получить список моделей Codex"));
      else {
        const models = normalizeModels(entries);
        models.length
          ? resolve(models)
          : reject(Error("Codex вернул пустой список моделей"));
      }
    };
    const send = (record) => child.stdin.write(JSON.stringify(record) + "\n");
    const timer = setTimeout(() => {
      finish(true);
      child.kill("SIGKILL");
    }, timeout);
    const parser = jsonLines((record) => {
      if (settled || record.id === undefined) return;
      if (record.error) return finish(true);
      if (record.id === 1) {
        send({ method: "initialized" });
        send({
          id: nextId,
          method: "model/list",
          params: { limit: 100, includeHidden: false },
        });
      } else if (record.id === nextId) {
        if (!Array.isArray(record.result?.data)) return finish(true);
        entries.push(...record.result.data);
        const cursor = record.result.nextCursor;
        if (!cursor) return finish();
        if (cursors.has(cursor) || cursors.size >= 20) return finish(true);
        cursors.add(cursor);
        send({
          id: ++nextId,
          method: "model/list",
          params: { limit: 100, includeHidden: false, cursor },
        });
      }
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 5000000) return finish(true);
      parser.write(chunk);
    });
    child.on("error", () => finish(true));
    child.on("close", () => finish(true));
    child.stdin.on("error", () => finish(true));
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "promptcore_arena", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      },
    });
  });
}

export function decisionTimeout(reasoning) {
  return (
    { medium: 120000, high: 180000, xhigh: 240000, max: 300000, ultra: 360000 }[
      reasoning
    ] || 90000
  );
}
