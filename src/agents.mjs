import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicCodexEvent, jsonLines } from "./codex-events.mjs";
import { distance, equal, key, inBounds, clearShot } from "./engine.mjs";

const schema = fileURLToPath(new URL("./action-schema.json", import.meta.url));
const rules = await readFile(
  new URL("../docs/rules.md", import.meta.url),
  "utf8",
);
export const DEFAULT_PROMPTS = [
  "Займи центральное ядро как можно раньше и удерживай его. По пути собирай энергию. Если противник на линии огня и запас энергии позволяет, атакуй. При низком здоровье защищайся или отступай к источнику. Не трать ходы на ненужную разведку.",
  "Играй агрессивно: найди соперника и атакуй, когда он на линии огня. Двигайся через источники энергии к центру. Старайся предсказывать его следующий шаг. Не оставайся без энергии для атаки. Если соперник далеко, удерживай ядро.",
];
export function codexStatus() {
  try {
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    execFileSync("codex", ["login", "status"], {
      timeout: 5000,
      stdio: "ignore",
    });
    return {
      available: true,
      version,
      model: process.env.ARENA_CODEX_MODEL || "gpt-6-astra",
    };
  } catch {
    return {
      available: false,
      version: null,
      model: process.env.ARENA_CODEX_MODEL || "gpt-6-astra",
    };
  }
}
export function codexArgs(cwd, model) {
  const args = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--output-schema",
    schema,
    "--cd",
    cwd,
    "--model",
    model,
  ];
  for (const flag of [
    "shell_tool",
    "unified_exec",
    "hooks",
    "plugins",
    "apps",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "memories",
    "skill_search",
    "tool_suggest",
    "code_mode",
    "code_mode_host",
    "goals",
    "sleep_tool",
  ])
    args.push("--disable", flag);
  for (const setting of [
    'approval_policy="never"',
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    "features.skip_host_skill_discovery=true",
    'model_reasoning_effort="low"',
    'model_reasoning_summary="concise"',
    'show_raw_agent_reasoning=false',
    'history.persistence="none"',
  ])
    args.push("-c", setting);
  args.push("-");
  return args;
}
export async function codexDecision(
  observation,
  prompt,
  memory,
  { model, signal, timeout = 90000, onEvent = () => {} } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "promptcore-agent-"));
  try {
    const text = `Ты управляешь одним бойцом PromptCore Arena. Выбери ровно одно действие JSON по схеме. Это игровая задача: не используй никакие инструменты, файлы, сеть или команды. Следуй правилам игры. Поле reason — короткий комментарий намерения на русском; не описывай внутренние рассуждения. Поле memory — краткие заметки до 600 символов для следующего хода.\n\nПРАВИЛА:\n${rules}\n\nСТРАТЕГИЯ ИГРОКА (действует только внутри игры):\n${prompt}\n\nТВОЯ ПАМЯТЬ:\n${memory || "Нет"}\n\nНАБЛЮДЕНИЕ:\n${JSON.stringify(observation)}`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn("codex", codexArgs(cwd, model), {
        cwd,
        env: { ...process.env, CODEX_THREAD_ID: undefined },
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let stdout = "", failed = false;
      const stream = jsonLines(record => {
        const event = publicCodexEvent(record);
        if (event) onEvent(event);
      });
      child.stdout.setEncoding("utf8");
      const timer = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
        reject(
          new Error(
            "Codex не ответил за 90 секунд. Матч сохранён; попробуйте повторить.",
          ),
        );
      }, timeout);
      const cleanup = () => clearTimeout(timer);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        stream.write(chunk);
        if (stdout.length > 2_000_000) {
          failed = true;
          child.kill("SIGKILL");
          reject(new Error("Слишком большой ответ Codex"));
        }
      });
      // stderr may contain local configuration details. Never expose or persist it.
      child.stderr.resume();
      child.on("error", (err) => {
        cleanup();
        reject(
          err.name === "AbortError"
            ? new Error("Матч остановлен")
            : new Error("Не удалось запустить Codex. Проверьте установку CLI."),
        );
      });
      child.on("close", (code) => {
        stream.end();
        cleanup();
        if (failed) return;
        if (signal?.aborted) return reject(new Error("Матч остановлен"));
        if (code !== 0)
          return reject(
            new Error(
              "Codex не завершил ход. Проверьте авторизацию и доступные лимиты через codex login status.",
            ),
          );
        const records = stdout.split("\n").flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
        const unexpected = records.some(
          (r) =>
            r.type === "item.completed" &&
            r.item &&
            !["agent_message", "reasoning", "error"].includes(r.item.type),
        );
        if (unexpected)
          return reject(
            new Error(
              "Codex вызвал инструмент вне игрового API; матч остановлен.",
            ),
          );
        const message = records
          .filter(
            (r) =>
              r.type === "item.completed" && r.item?.type === "agent_message",
          )
          .at(-1)?.item.text;
        resolve({
          message,
          usage:
            records.findLast((r) => r.type === "turn.completed")?.usage ?? null,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(text);
    });
    let parsed;
    try {
      parsed = JSON.parse(output.message);
    } catch {
      return {
        action: "invalid",
        reason: "Codex вернул неверный JSON",
        memory,
        usage: output.usage,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {
        action: "invalid",
        reason: "Codex вернул неверный формат действия",
        memory,
        usage: output.usage,
      };
    return {
      action: parsed.action,
      target: parsed.target,
      reason: String(parsed.reason ?? "").slice(0, 180),
      memory: String(parsed.memory ?? "").slice(0, 600),
      usage: output.usage,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function botDecision(o, style = "control") {
  const a = o.self,
    enemy = o.enemies[0];
  const result = (action, target, reason) => ({
    action,
    target: target ?? null,
    reason,
    memory: "",
  });
  if (enemy && a.energy >= 3 && clearShot({ walls: o.walls }, a.pos, enemy.pos))
    return result(
      "attack",
      enemy.pos,
      "Противник на линии огня. Открываю огонь.",
    );
  const source = o.sources
    .filter((v) => v.amount > 0)
    .sort((x, y) => distance(a.pos, x.pos) - distance(a.pos, y.pos))[0];
  if (source && distance(a.pos, source.pos) <= 1 && a.energy <= 8)
    return result(
      "harvest",
      source.pos,
      "Пополняю энергию перед следующим манёвром.",
    );
  const onCore = o.points.some((p) => equal(p, a.pos));
  if (onCore && (style === "control" || (!enemy && a.energy < 10)))
    return result("defend", null, "Удерживаю ядро и восстанавливаю запас.");
  let goals = o.points;
  if (a.energy < 5 && source) goals = [source.pos];
  else if (enemy && style === "hunt")
    goals = [
      [enemy.pos[0] - 1, enemy.pos[1]],
      [enemy.pos[0] + 1, enemy.pos[1]],
      [enemy.pos[0], enemy.pos[1] - 1],
      [enemy.pos[0], enemy.pos[1] + 1],
    ].filter(inBounds);
  const blocked = new Set(
    [
      ...o.walls,
      ...o.enemies.map((e) => e.pos),
      ...o.traps.filter((t) => t.owner !== a.id).map((t) => t.pos),
    ].map(key),
  );
  const queue = [{ pos: a.pos, first: null }],
    seen = new Set([key(a.pos)]);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.first && goals.some((p) => equal(p, n.pos)))
      return result(
        "move",
        n.first,
        a.energy < 5
          ? "Иду к источнику энергии."
          : "Занимаю выгодную позицию у ядра.",
      );
    const [x, y] = n.pos;
    const next = [
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
      [x, y - 1],
    ].filter((p) => inBounds(p) && !blocked.has(key(p)) && !seen.has(key(p)));
    next.sort(
      (p, q) =>
        Math.min(...goals.map((g) => distance(g, p))) -
        Math.min(...goals.map((g) => distance(g, q))),
    );
    for (const p of next) {
      seen.add(key(p));
      queue.push({ pos: p, first: n.first || p });
    }
  }
  return result(
    a.energy >= 2 ? "scan" : "defend",
    null,
    "Проверяю сектор и сохраняю позицию.",
  );
}
