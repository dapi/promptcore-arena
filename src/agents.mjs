import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicCodexEvent, jsonLines } from "./codex-events.mjs";
import { distance, equal, key, inBounds, clearShot } from "./engine.mjs";

const schema = fileURLToPath(
  new URL("./action-choice-schema.json", import.meta.url),
);
const rules = await readFile(
  new URL("../docs/rules.md", import.meta.url),
  "utf8",
);
// Used only to migrate untouched starter drafts; edited strategies are retained.
export const LEGACY_DEFAULT_PROMPTS = [
  "Займи центральное ядро как можно раньше и удерживай его. По пути собирай энергию. Если противник на линии огня и запас энергии позволяет, атакуй. При низком здоровье защищайся или отступай к источнику. Не трать ходы на ненужную разведку.",
  "Играй агрессивно: найди соперника и атакуй, когда он на линии огня. Двигайся через источники энергии к центру. Старайся предсказывать его следующий шаг. Не оставайся без энергии для атаки. Если соперник далеко, удерживай ядро.",
];
export const DEFAULT_PROMPTS = [
  "Ты тактик. Побеждай по очкам контроля: занимай свободную активную зону и заранее выбирай путь к следующей. Когда соперник входит в зону, решай, выгоднее ли выбить его или перехватить следующую цель. Сохраняй здоровье: уходи с линии огня, используй укрытия. Атакуй ради освобождения зоны или добивания. При энергии меньше 3 заходи на батарейку по пути. Запоминай следующую цель и опасные клетки.",
  "Ты охотник. Побеждай уничтожением: ищи соперника возле активной и следующей зон, перехватывай его путь к батарейкам. С энергией от 3 занимай линию выстрела и дави атаками; учитывай, что соперник может сдвинуться. При низком запасе сначала подбери батарейку, затем продолжай преследование. Ловушки ставь на вероятном пути отхода. Когда соперник пропал, иди к его последней позиции или следующей зоне. Запоминай его маршрут.",
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
      model: process.env.ARENA_CODEX_MODEL || "gpt-6-luna",
    };
  } catch {
    return {
      available: false,
      version: null,
      model: process.env.ARENA_CODEX_MODEL || "gpt-6-luna",
    };
  }
}
export function codexArgs(cwd, model, reasoning = "low", schemaPath = schema) {
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
    schemaPath,
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
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    'model_reasoning_summary="concise"',
    "show_raw_agent_reasoning=false",
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
  {
    model,
    reasoning = "low",
    signal,
    timeout = 90000,
    onEvent = () => {},
    onUsage = () => {},
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "promptcore-agent-"));
  try {
    const choices = observation.legalActions;
    if (!Array.isArray(choices) || !choices.length)
      throw new Error("Нет допустимых действий для бойца");
    const choiceSchema = JSON.parse(await readFile(schema, "utf8"));
    choiceSchema.properties.choice.enum = choices.map((d) => d.choice);
    const schemaPath = join(cwd, "choices.json");
    await writeFile(schemaPath, JSON.stringify(choiceSchema), { mode: 0o600 });
    const text = `Ты управляешь одним бойцом PromptCore Arena. Верни JSON {"choice": номер, "reason": комментарий, "memory": заметки} по схеме. Это игровая задача: не используй никакие инструменты, файлы, сеть или команды. Следуй правилам игры. В наблюдении legalActions перечислены допустимые действия с номером choice. Верни номер выбранного действия; приложение само подставит action и target. Поле navigation даёт первый choice кратчайшего маршрута к zone (активная зона), nextZone (следующая зона), battery (батарейка) и firingPosition (позиция для выстрела по видимому противнику). Выбери цель по своей стратегии и используй её choice для обхода стен. steps=0 означает, что ты уже на цели; дальше решай, ждать, стрелять или выбрать другую цель. Маршруты используют только уже известные стены; неизвестные клетки считаются открытыми. Для движения target — ровно один соседний шаг, а не конечная цель маршрута. Если previousAction сообщает ошибку или столкновение, выбери другой допустимый шаг. Поле reason — короткий комментарий намерения на русском; не описывай внутренние рассуждения. Поле memory — краткие заметки до 600 символов для следующего хода.\n\nПРАВИЛА:\n${rules}\n\nСТРАТЕГИЯ ИГРОКА (действует только внутри игры):\n${prompt}\n\nТВОЯ ПАМЯТЬ:\n${memory || "Нет"}\n\nНАБЛЮДЕНИЕ:\n${JSON.stringify(observation)}`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        "codex",
        codexArgs(cwd, model, reasoning, schemaPath),
        {
          cwd,
          env: { ...process.env, CODEX_THREAD_ID: undefined },
          stdio: ["pipe", "pipe", "pipe"],
          signal,
        },
      );
      let stdout = "",
        failure = null,
        threadId = null;
      const stream = jsonLines((record) => {
        if (record.type === "thread.started") threadId = record.thread_id;
        if (record.type === "turn.completed" && record.usage)
          onUsage({ usage: record.usage, threadId });
        const event = publicCodexEvent(record);
        if (event) onEvent(event);
      });
      child.stdout.setEncoding("utf8");
      const timer = setTimeout(() => {
        failure = new Error(
          `Codex не ответил за ${Math.round(timeout / 1000)} секунд. Матч сохранён; попробуйте повторить.`,
        );
        child.kill("SIGKILL");
      }, timeout);
      const cleanup = () => clearTimeout(timer);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        stream.write(chunk);
        if (stdout.length > 2_000_000) {
          failure = new Error("Слишком большой ответ Codex");
          child.kill("SIGKILL");
        }
      });
      // stderr may contain local configuration details. Never expose or persist it.
      child.stderr.resume();
      child.on("error", (err) => {
        cleanup();
        // Abort sends SIGTERM first. Do not wait forever if the CLI ignores it;
        // close still drains buffered stdout, including any reported usage.
        if (err.name === "AbortError" && child.pid) child.kill("SIGKILL");
        failure =
          err.name === "AbortError"
            ? new Error("Матч остановлен")
            : new Error("Не удалось запустить Codex. Проверьте установку CLI.");
      });
      child.on("close", (code) => {
        stream.end();
        cleanup();
        if (failure) return reject(failure);
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
    const selected = choices.find((d) => d.choice === parsed.choice);
    if (!selected)
      return {
        action: "invalid",
        reason: "Codex выбрал неизвестное действие",
        memory,
        usage: output.usage,
      };
    return {
      action: selected.action,
      target: selected.target,
      choice: selected.choice,
      reason: String(parsed.reason ?? "").slice(0, 180),
      memory: String(parsed.memory ?? "").slice(0, 600),
      usage: output.usage,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function botDecision(o, style = "control") {
  if (o.version === "arena/2") return mobileDecision(o, style);
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

// Deterministic training policies. Prompts control Codex, not these bots.
function mobileDecision(o, style) {
  const a = o.self,
    enemy = o.enemies[0];
  const result = (action, target, reason) => ({
    action,
    target: target ?? null,
    reason,
    memory: "",
  });
  const onZone = o.points.some((p) => equal(p, a.pos));
  const contested = enemy && o.points.some((p) => equal(p, enemy.pos));
  const canShoot =
    enemy && a.energy >= 3 && clearShot({ walls: o.walls }, a.pos, enemy.pos);
  if (canShoot && (style === "hunt" || contested || enemy.hp <= 3))
    return result(
      "attack",
      enemy.pos,
      style === "hunt"
        ? "Перехватил соперника. Атакую."
        : "Освобождаю зону контроля.",
    );
  const blocked = new Set(
    [
      ...o.walls,
      ...o.enemies.map((e) => e.pos),
      ...o.traps.filter((t) => t.owner !== a.id).map((t) => t.pos),
    ].map(key),
  );
  const routes = new Map([[key(a.pos), { pos: a.pos, first: null, steps: 0 }]]);
  const queue = [...routes.values()];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i],
      [x, y] = n.pos;
    for (const p of [
      [x + 1, y],
      [x, y + 1],
      [x - 1, y],
      [x, y - 1],
    ]) {
      if (!inBounds(p) || blocked.has(key(p)) || routes.has(key(p))) continue;
      const path = { pos: p, first: n.first ?? p, steps: n.steps + 1 };
      routes.set(key(p), path);
      queue.push(path);
    }
  }
  const nearest = (goals) =>
    goals
      .map((p) => routes.get(key(p)))
      .filter(Boolean)
      .sort((a, b) => a.steps - b.steps)[0];
  const battery = nearest(o.batteries.map((b) => b.pos));
  if (a.energy < 3 && battery?.first)
    return result(
      "move",
      battery.first,
      "Подбираю батарейку для следующей атаки.",
    );
  if (style === "hunt" && enemy && a.energy >= 3) {
    const lanes = queue.filter(
      (n) => n.first && clearShot({ walls: o.walls }, n.pos, enemy.pos),
    );
    if (lanes.length)
      return result(
        "move",
        lanes.sort((a, b) => a.steps - b.steps)[0].first,
        "Перехожу на линию огня.",
      );
  }
  let goals = o.points;
  if (o.zone.nextPoints && (style === "control" || !enemy))
    goals = o.zone.nextPoints;
  if (
    style === "control" &&
    enemy &&
    a.hp <= 4 &&
    clearShot({ walls: o.walls }, enemy.pos, a.pos)
  ) {
    const safe = queue.filter(
      (n) => n.steps === 1 && !clearShot({ walls: o.walls }, enemy.pos, n.pos),
    );
    safe.sort(
      (p, q) =>
        Math.min(...goals.map((g) => distance(g, p.pos))) -
        Math.min(...goals.map((g) => distance(g, q.pos))),
    );
    if (safe[0])
      return result(
        "move",
        safe[0].first,
        "Ухожу из-под огня к следующей цели.",
      );
  }
  if (onZone && !o.zone.nextPoints && !contested) {
    if (enemy && a.energy >= 1)
      return result("defend", null, "Защищаюсь и сохраняю контроль.");
    return result("wait", null, "Контролирую зону, берегу энергию.");
  }
  const route = nearest(goals);
  if (route?.first)
    return result(
      "move",
      route.first,
      o.zone.nextPoints
        ? "Перехожу к следующей зоне."
        : "Занимаю активную зону.",
    );
  if (battery?.first && a.energy <= 8)
    return result(
      "move",
      battery.first,
      "Батарейка доступна — пополняю запас.",
    );
  return result("wait", null, "Сохраняю позицию и энергию.");
}
