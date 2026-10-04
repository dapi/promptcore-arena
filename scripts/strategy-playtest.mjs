// Actual Codex strategies, through the same API and adapter used by the game.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { analyzeMatch, seriesStats } from "../web/match-stats.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "npm run playtest:codex -- [--seed code] [--model id] [--reasoning low] [--prompts file.json] [--url http://127.0.0.1:port]\nРеальные запросы Codex: 2 карты × 2 старта, до 320 вызовов. Отчёт: .arena/reports/. Ctrl+C останавливает серию.",
  );
  process.exit(0);
}
const allowed = new Set([
  "--url",
  "--seed",
  "--model",
  "--reasoning",
  "--prompts",
]);
for (let i = 0; i < args.length; i += 2)
  if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Неизвестный параметр или нет значения: ${args[i]}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Нужно значение --${name}`);
  return args[i + 1];
};
let base = option("url", null);
if (!base) {
  try {
    base = `http://127.0.0.1:${execFileSync("port-selector", ["--name", "web"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()}`;
  } catch {
    throw new Error(
      "Укажи адрес запущенной игры через --url или установи port-selector.",
    );
  }
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base))
  throw new Error("Нужен локальный адрес игры");
const api = async (path, body) => {
  const res = await fetch(
    base + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`);
  return value;
};
const config = await api("/api/config");
if (!config.codex.available) throw new Error("Codex недоступен");
const promptFile = option("prompts", null);
const prompts = promptFile
  ? JSON.parse(await readFile(promptFile, "utf8"))
  : config.prompts;
const input = {
  mode: "codex",
  series: true,
  seed: option("seed", "strategy-check-01"),
  model: option("model", config.codex.model),
  reasoning: option("reasoning", "low"),
  prompts,
};
const startedAt = new Date().toISOString();
const { id } = await api("/api/run", input);
console.log(
  `Серия ${id} · ${input.model} / ${input.reasoning} · 2 карты × 2 старта`,
);
let cancelled = false;
process.on("SIGINT", () => {
  if (!cancelled) {
    cancelled = true;
    void api(`/api/jobs/${id}/cancel`, {}).catch(() => {});
  }
});
let job,
  previous = "";
do {
  job = await api(`/api/jobs/${id}`);
  const match = job.matches.at(-1);
  const signature = `${job.matches.length}:${match?.frames.length}:${job.status}`;
  if (signature !== previous) {
    console.log(
      `Бой ${job.matches.length}/4 · ход ${Math.max(0, (match?.frames.length || 1) - 1)} · ${job.status} · токены ${job.statistics.usage.total ?? "нет данных"}`,
    );
    previous = signature;
  }
  if (job.status === "running") await new Promise((r) => setTimeout(r, 2000));
} while (job.status === "running");
const report = {
  id,
  startedAt,
  finishedAt: new Date().toISOString(),
  status: job.status,
  error: job.error ?? null,
  kind: "Codex strategies; 2 maps with swapped starts; exploratory sample",
  input,
  promptHashes: prompts.map((p) =>
    createHash("sha256").update(p).digest("hex"),
  ),
  statistics: seriesStats(job.matches),
  matches: job.matches.map((m) => ({
    id: m.id,
    seed: m.seed,
    swap: m.swap,
    version: m.version,
    model: m.model,
    reasoning: m.reasoning,
    cliVersion: m.cliVersion,
    status: m.status,
    result: m.frames.at(-1).state.result,
    final: m.frames.at(-1).state.agents,
    analysis: analyzeMatch(m),
    usage: m.usage,
  })),
};
const directory = resolve(".arena/reports");
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = join(directory, `${id}.json`);
await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      status: report.status,
      statistics: report.statistics,
      report: `.arena/reports/${id}.json`,
    },
    null,
    2,
  ),
);
if (report.status !== "complete") process.exitCode = 1;
