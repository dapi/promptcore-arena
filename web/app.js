import { PromptEditor } from "./prompt-editor.js";
import {
  analyzeMatch,
  matchUsage,
  aggregateUsage,
  usageRequests,
  seriesStats,
} from "./match-stats.js";
import { Arena } from "./arena.js";
import { ArenaSound } from "./sound.js";
import {
  randomizeAvatars,
  AVATARS,
  DEFAULT_FIGHTERS,
  normalizeFighters,
  avatarUrl,
  fighterName,
} from "./fighters.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const names = { A: "Вектор", B: "Фантом" },
  actions = {
    move: "ПЕРЕМЕЩЕНИЕ",
    attack: "АТАКА",
    scan: "СКАНИРОВАНИЕ",
    trap: "ЛОВУШКА",
    defend: "ЗАЩИТА",
    harvest: "СБОР",
    wait: "ОЖИДАНИЕ",
    invalid: "ПРОПУСК",
  };
const icons = {
  move: "↗",
  attack: "⌖",
  miss: "⌖",
  scan: "◎",
  harvest: "ϟ",
  pickup: "ϟ",
  battery_wave: "ϟ",
  zone_shift: "◎",
  contested: "↔",
  defend: "◇",
  trap: "✳",
  explosion: "✷",
  death: "×",
  control: "▣",
  collision: "↔",
  invalid: "!",
};
const arena = new Arena($("#battlefield"));
const sound = new ArenaSound({ onChange: updateSoundButton });
function updateSoundButton() {
  const button = $("#sound-toggle");
  const label = sound.ready ? "Выключить звук" : "Включить звук";
  button.disabled = !sound.available;
  button.setAttribute("aria-pressed", String(sound.ready));
  button.setAttribute("aria-label", label);
  button.title = sound.available
    ? sound.ready
      ? label
      : "Включить звук · прозвучит короткий сигнал"
    : "Этот браузер не поддерживает звук игры";
  $("#sound-label").textContent = !sound.available
    ? "Звук недоступен"
    : sound.ready
      ? "Звук"
      : sound.enabled
        ? "Включить звук"
        : "Без звука";
}
updateSoundButton();
$("#sound-toggle").addEventListener("click", () => {
  void sound.toggle();
});
function unlockSound(event) {
  // Let the sound button handle its own activation before changing its state.
  if (!event.target.closest?.("#sound-toggle")) void sound.unlock();
}
document.addEventListener("click", unlockSound, { capture: true });
document.addEventListener("keydown", unlockSound, { capture: true });

let config,
  match = null,
  frames = [],
  index = 0,
  pov = "all",
  playing = false,
  timer = null,
  job = null,
  jobData = null,
  pollTimer = null,
  previewSeq = 0,
  launching = false,
  stream = null,
  progress = null,
  trace = [],
  streamState = "Ожидание",
  pollInFlight = false,
  telemetryView = "messages",
  followLive = false;
let fighters = normalizeFighters(DEFAULT_FIGHTERS);
let promptsLocked = false;
const promptEditor = new PromptEditor($("#prompt-dialog"), {
  read: (id) => $(`#prompt-${id}`).value,
  write: (id, value) => {
    $(`#prompt-${id}`).value = value;
    saveDraft();
  },
  editable: () => !promptsLocked && !launching && !job,
  name: (id) => names[id.toUpperCase()],
});
function readFighters() {
  return normalizeFighters(
    ["a", "b"].map((id, i) => ({
      ...fighters[i],
      name: $(`#fighter-name-${id}`).value,
    })),
  );
}
function setFighters(value, { fields = false } = {}) {
  fighters = normalizeFighters(value);
  arena.setFighters(fighters);
  for (const f of fighters) {
    const id = f.id.toLowerCase();
    names[f.id] = f.name;
    document.documentElement.style.setProperty(`--${id}`, f.color);
    $(`#avatar-image-${id}`).src = avatarUrl(f);
    $(`#avatar-image-${id}`).dataset.avatar = f.avatar;
    if (fields) {
      $(`#fighter-name-${id}`).value = f.name;
    }
  }
}
const setMessage = (text) => {
  $("#app-message").textContent = text;
};
async function api(path, body) {
  const r = await fetch(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}
const stageNames = {
  starting: "Запускаю Codex",
  connected: "Codex подключён",
  thinking: "Выбирает действие",
  summary: "Пришло пояснение",
  message: "Получен текст модели",
  received: "Проверяем ответ",
  ready: "Действие готово",
  error: "Ошибка",
  cancelled: "Остановлен",
};
const clockText = (ms) =>
  `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
let monitorSignature = "";
function updateMonitor() {
  const running = launching || Boolean(job);
  $("#run-progress").hidden = !running;
  const elapsed = Math.max(0, Date.now() - (progress?.startedAt || Date.now()));
  $("#progress-clock").textContent = clockText(elapsed);
  const current = jobData?.matches.at(-1);
  const liveView =
    launching || Boolean(job && followLive && match?.id === current?.id);
  arena.setActivity(liveView ? progress?.agents || {} : {});
  const turn = progress?.turn || jobData?.thinking || 1;
  $("#progress-title").textContent = launching
    ? "Запускаю бой…"
    : `Бой идёт · рассчитывается ход ${turn}`;
  const done = Object.values(progress?.agents || {}).filter(
    (a) => a.phase === "ready",
  ).length;
  $("#progress-detail").textContent = launching
    ? "Передаю стратегии бойцам"
    : done === 1
      ? "Один боец ответил. Ожидаем второго — ход выполняется одновременно."
      : elapsed > 45000
        ? `Ждём ответ Codex. Лимит хода — ${Math.round((progress?.timeoutMs || current?.decisionTimeoutMs || 90000) / 1000)} секунд.`
        : "Бойцы выбирают действия одновременно.";
  if (selectedMode() === "training")
    $("#progress-detail").textContent =
      "Встроенные боты рассчитывают ход. Обращений к модели нет.";
  $("#progress-count").textContent =
    `${current?.frames.length - 1 || 0} / 40 ходов`;
  $("#battle-progress").value = current?.frames.length - 1 || 0;
  const currentFrame = frames[index];
  const savedTrace = (match?.modelEvents || []).filter(
    (e) => e.turn === currentFrame?.state.turn,
  );
  const replayTrace = savedTrace.length
    ? savedTrace
    : Object.entries(currentFrame?.decisions || {}).map(([id, d], i) => ({
        seq: i,
        agent: id,
        turn: currentFrame.state.turn,
        phase: "message",
        text: JSON.stringify(
          {
            action: d.action,
            target: d.target,
            reason: d.reason,
            memory: d.memory,
          },
          null,
          2,
        ),
      }));
  const visibleTrace = liveView
    ? trace.filter((e) => !current || e.matchId === current.id)
    : replayTrace;
  const hasMessages = (running ? selectedMode() : match?.mode) === "codex";
  const canAnalyze = Boolean(match && match.status !== "running" && !launching);
  const showAnalysis = canAnalyze && telemetryView === "analysis";
  const showMessages =
    !showAnalysis && hasMessages && telemetryView !== "chronicle";
  $("#analysis-tab").hidden = !canAnalyze;
  $("#analysis-tab").setAttribute("aria-selected", String(showAnalysis));
  $("#analysis-panel").hidden = !showAnalysis;
  renderUsage();
  $("#messages-tab").disabled = !hasMessages;
  $("#messages-tab").setAttribute("aria-selected", String(showMessages));
  $("#chronicle-tab").setAttribute(
    "aria-selected",
    String(!showMessages && !showAnalysis),
  );
  $("#model-monitor").hidden = !showMessages;
  $("#chronicle-panel").hidden = showMessages || showAnalysis;
  $(".monitor-title h2").textContent = liveView
    ? "Сейчас в Codex"
    : "Сообщения этого хода";
  $("#stream-status").textContent = liveView
    ? streamState
    : `ХОД ${currentFrame?.state.turn ?? 0} · ЗАПИСЬ`;
  const signature = JSON.stringify([
    liveView,
    pov,
    turn,
    currentFrame?.state.turn,
    match?.id,
    visibleTrace.length,
    visibleTrace.at(-1)?.seq,
    progress?.agents,
  ]);
  if (signature !== monitorSignature) {
    monitorSignature = signature;
    $("#model-agents").innerHTML = ["A", "B"]
      .map((id) => {
        const agent = liveView ? progress?.agents?.[id] : null;
        const hidden = pov !== "all" && pov !== id;
        const messages = visibleTrace.filter(
          (e) =>
            e.agent === id &&
            ["summary", "message", "ready", "error", "cancelled"].includes(
              e.phase,
            ),
        );
        const deduped = new Map();
        for (const e of messages)
          deduped.set(`${e.turn}:${e.itemId || e.seq}`, e);
        const lines = [...deduped.values()].slice(-12);
        const content = hidden
          ? '<p class="model-empty">Сообщения соперника скрыты в этом режиме обзора.</p>'
          : lines.length
            ? lines
                .map(
                  (e) =>
                    `<article><span>ХОД ${e.turn}${e.phase === "summary" ? " · Пояснение" : ""}</span>${e.phase === "message" ? `<details><summary>Ответ модели · JSON</summary><pre>${escape(e.text)}</pre></details>` : `<p>${escape(e.text)}</p>`}</article>`,
                )
                .join("")
            : '<p class="model-empty">Ждём ответ…</p>';
        return `<section class="model-agent fighter-${id.toLowerCase()} ${escape(agent?.phase || "")}"><div class="model-agent-header"><b>${id}</b> ${escape(names[id])}<time data-agent-clock="${id}"></time></div><div class="model-phase"><i></i>${escape(agent ? stageNames[agent.phase] : liveView ? "Ожидание ответа" : "Сохранённый ход")}</div><div class="model-log">${content}</div></section>`;
      })
      .join("");
    $$(".model-log").forEach((el) => (el.scrollTop = el.scrollHeight));
  }
  for (const id of ["A", "B"]) {
    const phase = liveView ? progress?.agents?.[id]?.phase || "starting" : "";
    const pending = [
      "starting",
      "connected",
      "thinking",
      "summary",
      "message",
      "received",
    ].includes(phase);
    const card = $(`.fighter-editor.fighter-${id.toLowerCase()}`);
    card.classList.toggle("is-thinking", pending);
    const state = currentFrame?.state.agents.find((a) => a.id === id);
    if (state)
      $(`#fighter-action-${id.toLowerCase()}`).textContent = !arena.visible(
        state.pos,
      )
        ? "ВНЕ ОБЗОРА"
        : pending
          ? "Думает…"
          : liveView && phase === "ready"
            ? "Ход готов"
            : state.hp <= 0
              ? "УНИЧТОЖЕН"
              : pov !== "all" && pov !== id
                ? "В ПОЛЕ ЗРЕНИЯ"
                : actions[currentFrame.decisions?.[id]?.action] || "ГОТОВ";
    const a = progress?.agents?.[id],
      el = $(`[data-agent-clock="${id}"]`);
    if (el)
      el.textContent =
        liveView && a
          ? clockText(a.elapsedMs ?? Math.max(0, Date.now() - a.startedAt))
          : "";
  }
  const canReplay = !running && frames.length > 1;
  $(".playback").hidden = !canReplay;
  $("#speed").disabled = !canReplay;
  $("#speed").title = "Скорость повтора";
  $("#play").textContent = playing ? "Ⅱ" : "▶";
  $("#play").setAttribute(
    "aria-label",
    playing ? "Приостановить просмотр" : "Продолжить просмотр",
  );
  $("#play").title = playing ? "Пауза повтора" : "Продолжить просмотр";
  $("#play").disabled = !canReplay;
  $("#timeline").disabled = !canReplay;
  $("#timeline").title =
    `Рассчитано ${Math.max(0, frames.length - 1)} из 40 ходов`;
  $("#live").textContent = followLive ? "● Сейчас" : "В эфир →";
  $("#live").classList.toggle("following", followLive);
  $("#live").hidden = !job || followLive;
  if (match)
    $("#battle-status").textContent = liveView
      ? `Прямой эфир · ход ${currentFrame?.state.turn ?? 0}`
      : `${playing ? "Повтор" : "Пауза просмотра"} · ход ${currentFrame?.state.turn ?? 0}`;
}

function mergeTrace(entries) {
  const map = new Map(trace.map((e) => [e.seq, e]));
  for (const e of entries || []) map.set(e.seq, e);
  trace = [...map.values()].sort((a, b) => a.seq - b.seq).slice(-2000);
}
function connectStream(id) {
  stream?.close();
  streamState = "Подключение…";
  stream = new EventSource(`/api/jobs/${id}/events`);
  stream.onopen = () => {
    streamState = "● ПРЯМОЙ ПОТОК";
    updateMonitor();
  };
  stream.onerror = () => {
    streamState = "ОБНОВЛЯЕМ СТАТУС";
    updateMonitor();
  };
  stream.onmessage = ({ data }) => {
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    mergeTrace([e]);
    if (e.type === "appearance" && e.matchId === match?.id) {
      match.fighters = e.fighters;
      setFighters(e.fighters);
      saveDraft();
    }
    if (e.type === "turn_started" && (!progress || e.turn >= progress.turn))
      progress = { turn: e.turn, startedAt: e.startedAt, agents: {} };
    if (e.type === "agent") {
      if (!progress || e.turn > progress.turn)
        progress = { turn: e.turn, startedAt: e.at, agents: {} };
      if (e.turn === progress.turn)
        progress.agents[e.agent] = {
          ...progress.agents[e.agent],
          ...e,
          startedAt: progress.agents[e.agent]?.startedAt || e.at,
        };
    }
    updateMonitor();
    if (["frame", "finished", "usage"].includes(e.type)) {
      clearTimeout(pollTimer);
      void poll();
    }
  };
}
setInterval(updateMonitor, 500);
window.addEventListener("pagehide", () => stream?.close());
function saveDraft() {
  try {
    localStorage.setItem(
      "arena-draft",
      JSON.stringify({
        rulesVersion: config.version,
        prompts: [$("#prompt-a").value, $("#prompt-b").value],
        seed: $("#seed").value,
        swap: $("#swap").checked,
        mode: selectedMode(),
        model: $("#model").value,
        reasoning: $("#reasoning").value,
        fighters: readFighters(),
      }),
    );
  } catch {}
}
function selectedMode() {
  return $("#model").value === "training" ? "training" : "codex";
}
const effortLabels = {
  none: "Без reasoning",
  minimal: "Минимальный",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  xhigh: "Очень высокий",
  max: "Максимальный",
  ultra: "Ультра",
};
function selectModel(model, reasoning) {
  const available = config.codex.models || [];
  model ||= config.codex.model || "";
  const chosen = available.find((m) => m.id === model);
  $("#model").innerHTML =
    available
      .map((m) => `<option value="${escape(m.id)}">${escape(m.name)}</option>`)
      .join("") + '<option value="training">Тренировка · без модели</option>';
  if (model !== "training" && !chosen) {
    const option = new Option(
      model ? `${model} · недоступна` : "Codex · каталог недоступен",
      model,
    );
    option.disabled = true;
    $("#model").add(option);
  }
  $("#model").value = model;
  const options =
    chosen?.efforts ||
    (model && model !== "training" && reasoning ? [reasoning] : []);
  $("#reasoning").innerHTML = options.length
    ? options
        .map(
          (e) =>
            `<option value="${escape(e)}">${escape(effortLabels[e] || e)}</option>`,
        )
        .join("")
    : '<option value="">—</option>';
  $("#reasoning").value = options.includes(reasoning)
    ? reasoning
    : chosen?.defaultReasoning || options[0] || "";
  updateMode();
}
function updateMode() {
  const training = selectedMode() === "training";
  const available = config?.codex.models?.some(
    (m) => m.id === $("#model").value,
  );
  const running =
    launching ||
    Boolean(job) ||
    $(".setup-panel").classList.contains("running");
  $("#reasoning").disabled = training || !available || running;
  $("#run").disabled = $("#series").disabled =
    running || (!training && (!config?.codex.available || !available));
  $("#mode-note").textContent = training
    ? "Промпты не влияют на встроенных ботов."
    : !config?.codex.available
      ? "Codex не авторизован. Выполните codex login."
      : config.codex.catalogNotice ||
        (!available
          ? "Эта модель больше недоступна. Выберите другую для нового боя."
          : "");
  $("#mode-note").classList.toggle(
    "offline",
    !training && (!config?.codex.available || !available),
  );
}
function lockPrompts(locked) {
  if (locked && !promptsLocked) promptEditor.close();
  promptsLocked = locked;
  for (const [i, id] of ["a", "b"].entries()) {
    const editor = $(`#prompt-${id}`);
    editor.disabled = false;
    editor.readOnly = true;
    editor
      .closest(".fighter-editor")
      .classList.toggle("strategy-locked", locked);
    $(`[data-reset="${i}"]`).hidden = locked;
    $(`[data-edit-prompt="${id}"]`).hidden =
      !locked || launching || Boolean(job);
    $(`[data-edit-prompt="${id}"]`).disabled = launching || Boolean(job);
    $(`[data-prompt-state="${id}"]`).textContent = locked
      ? "Только чтение"
      : "";
  }
}
function busy(value) {
  $(".setup-panel").classList.toggle("running", value);
  for (const el of $$(
    ".setup-panel textarea, .setup-panel select, .setup-panel input, .setup-panel button, .map-settings input, .map-settings button",
  ))
    el.disabled = value;
  $$("[data-avatar]").forEach((button) => (button.disabled = false));
  if (value) $(".map-settings").open = false;
  $(".map-lock-note").hidden = !value;
  lockPrompts(value || Boolean(match));
  if (value)
    $$("[data-edit-prompt]").forEach((button) => {
      button.disabled = true;
      button.hidden = true;
    });
  $("#cancel").disabled = false;
  $("#cancel").hidden = !value;
  $("#run span:first-child").textContent = value
    ? "Идёт бой…"
    : "Запустить бой";
  updateMode();
}
function showTab(name) {
  $$("[data-tab]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name),
  );
  $$(".tab-page").forEach((el) => (el.hidden = el.id !== `${name}-tab`));
  if (name === "archive") loadArchive();
}
$$("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)),
);
$$("[data-telemetry]").forEach((button) =>
  button.addEventListener("click", () => {
    telemetryView = button.dataset.telemetry;
    updateMonitor();
  }),
);
function stop() {
  sound.stop();
  playing = false;
  followLive = false;
  clearTimeout(timer);
  $("#play").textContent = "▶";
  $("#play").setAttribute("aria-label", "Продолжить просмотр");
  updateMonitor();
}
function play() {
  if (!frames.length) return;
  const atLive = Boolean(
    job &&
    match?.id === jobData?.matches.at(-1)?.id &&
    index === frames.length - 1,
  );
  stop();
  followLive = atLive;
  if (index === frames.length - 1 && match?.status !== "running")
    render(0, false);
  playing = true;
  $("#play").textContent = "Ⅱ";
  $("#play").setAttribute("aria-label", "Приостановить просмотр");
  updateMonitor();
  tick();
}
function tick() {
  if (!playing) return;
  timer = setTimeout(
    () => {
      if (!followLive && index < frames.length - 1) {
        render(index + 1, true);
        if (
          job &&
          match?.id === jobData?.matches.at(-1)?.id &&
          index === frames.length - 1
        )
          followLive = true;
      } else if (!job && match?.status !== "running") {
        stop();
        return;
      }
      tick();
    },
    Number($("#speed").value),
  );
}
function render(n, animate = false) {
  if (!frames.length) return;
  if (!animate) sound.stop();
  index = Math.max(0, Math.min(n, frames.length - 1));
  const f = frames[index],
    s = f.state;
  arena.setFrame(f, animate);
  arena.setPov(pov);
  $("#turn-label").textContent = String(s.turn).padStart(2, "0");
  $("#frame-label").textContent =
    `${String(index).padStart(2, "0")} / ${String(frames.length - 1).padStart(2, "0")}`;
  $("#timeline").max = frames.length - 1;
  $("#timeline").value = index;
  $("#prev").disabled = index === 0;
  $("#next").disabled = index >= frames.length - 1;
  $("#play").disabled = frames.length <= 1 && !job;
  $("#download").disabled = !match;
  $("#live").hidden = !job;
  $("#board-overlay").hidden = Boolean(match);
  $("#zone-status").hidden = !s.zone;
  if (s.zone) {
    const remaining = s.zone.endsAt - s.turn;
    const contested =
      s.agents.filter(
        (a) =>
          a.hp > 0 &&
          s.points.some((p) => p[0] === a.pos[0] && p[1] === a.pos[1]),
      ).length > 1;
    $("#zone-status").textContent =
      `${contested ? "Спорная зона · " : ""}${s.zone.nextPoints ? (remaining > 0 ? `Смена через ${remaining} х.` : "Зона перемещается") : "Последняя зона"}`;
    $("#zone-status").title =
      "Один боец в зоне получает очки. Если внутри оба — очков нет. Пунктир показывает следующую зону.";
  }
  $("#legend-core").textContent = s.zone ? "Зона" : "Ядро";
  $("#legend-energy").textContent = s.batteries
    ? "Батарейка +4"
    : "Источник энергии";
  $("#legend-energy").title = s.batteries
    ? "Подбирается при входе и исчезает. Новая волна каждые 6 ходов."
    : "Прежние правила: отдельное действие сбор, источник восстанавливается.";
  $("#result-banner").hidden = !s.result;
  if (s.result) {
    const r = s.result;
    const [a, b] = ["A", "B"].map((id) =>
      s.agents.find((agent) => agent.id === id),
    );
    const metrics = [
      { key: "hp", label: "Здоровье" },
      { key: "control", label: s.zone ? "Контроль зоны" : "Контроль ядра" },
      { key: "harvested", label: "Собрано энергии" },
    ];
    const deciding =
      a.hp <= 0 || b.hp <= 0
        ? "hp"
        : ["control", "hp", "harvested"].find((key) => a[key] !== b[key]);
    const reason =
      a.hp <= 0 || b.hp <= 0 || !r.winner
        ? r.reason
        : {
            control: s.zone
              ? "Победа по контролю зоны"
              : "Победа по контролю ядра",
            hp: "Победа по оставшемуся здоровью",
            harvested: "Победа по собранной энергии",
          }[deciding];
    $("#result-banner").innerHTML =
      `<span class="tiny">МАТЧ ЗАВЕРШЁН · ${s.turn} ХОДОВ</span><strong>${r.winner ? `${escape(names[r.winner])} побеждает` : "Ничья"}</strong><p>${escape(reason)}</p><table class="result-score" aria-label="Итоговые показатели бойцов"><thead><tr><th scope="col"><span class="sr-only">Показатель</span></th><th scope="col">${escape(names.A)}</th><th scope="col">${escape(names.B)}</th></tr></thead><tbody>${metrics.map(({ key, label }) => `<tr${key === deciding ? ' class="deciding"' : ""}><th scope="row">${label}</th><td>${a[key]}</td><td>${b[key]}</td></tr>`).join("")}</tbody></table>`;
  }
  $("#battlefield").setAttribute(
    "aria-label",
    `Арена 12 на 12, ход ${s.turn}. ${s.agents
      .filter((a) => arena.visible(a.pos))
      .map((a) => `${names[a.id]}: здоровье ${a.hp}, энергия ${a.energy}`)
      .join(". ")}. Обзор: ${pov === "all" ? "вся арена" : names[pov]}.`,
  );
  for (const a of s.agents) {
    const visible = arena.visible(a.pos),
      own = pov === "all" || pov === a.id;
    const id = a.id.toLowerCase();
    $(`#fighter-action-${id}`).textContent =
      `${!visible ? "ВНЕ ОБЗОРА" : a.hp <= 0 ? "УНИЧТОЖЕН" : own ? actions[f.decisions?.[a.id]?.action] || "ГОТОВ" : "В ПОЛЕ ЗРЕНИЯ"}`;
    $(`#fighter-status-${id}`).innerHTML =
      `<div><div class="bar-label"><span>Здоровье</span><b>${visible ? a.hp : "?"} <span class="dim">/ 10</span></b></div><div class="bar"><i style="width:${visible ? a.hp * 10 : 0}%"></i></div></div><div><div class="bar-label"><span>Энергия</span><b>${visible ? a.energy : "?"} <span class="dim">/ 12</span></b></div><div class="bar energy"><i style="width:${visible ? (a.energy / 12) * 100 : 0}%"></i></div></div><div class="stat-bottom"><span>КОНТРОЛЬ <b>${a.control}</b></span><span>СОБРАНО <b>${own ? a.harvested : "?"}</b></span></div>`;
  }
  const events = f.events.filter(
    (e) =>
      ["zone_shift", "battery_wave", "contested"].includes(e.type) ||
      pov === "all" ||
      e.actor === pov ||
      e.target === pov ||
      (e.pos && arena.visible(e.pos)) ||
      (e.to && arena.visible(e.to) && e.from && arena.visible(e.from)),
  );
  if (animate)
    sound.play(events, {
      key: `${match?.id}:${s.turn}`,
      finished: Boolean(s.result),
      winner: s.result?.winner,
    });
  $("#event-count").textContent = `${events.length} СОБЫТИЙ`;
  $("#event-feed").innerHTML = events.length
    ? events
        .map(
          (e) =>
            `<div class="event ${escape(e.type)}"><span class="event-icon">${icons[e.type] || "·"}</span><div><time>ХОД ${String(s.turn).padStart(2, "0")}</time><p>${escape(e.text.replace(/\b([AB])\b/g, (id) => names[id]))}</p></div></div>`,
        )
        .join("")
    : `<div class="empty-feed"><span>⌁</span><p>${s.turn ? "Тишина в секторе." : "Всё готово к бою."}</p><small>${s.turn ? "На этом ходу видимых событий нет." : "Запусти матч и наблюдай за решениями."}</small></div>`;
  for (const id of ["A", "B"])
    $(`#intent-${id.toLowerCase()} p`).textContent =
      pov !== "all" && pov !== id
        ? "Намерение соперника скрыто."
        : f.decisions?.[id]?.reason || "Жду сигнала к старту.";
  updateMonitor();
}
async function preview() {
  if (job) return;
  const seq = ++previewSeq;
  try {
    const state = await api(
      `/api/preview?seed=${encodeURIComponent($("#seed").value || "sector-07")}&swap=${$("#swap").checked}`,
    );
    if (seq !== previewSeq || job) return;
    stop();
    if (match?.version === "arena/1") {
      for (const [i, id] of ["a", "b"].entries())
        if ($(`#prompt-${id}`).value === config.legacyPrompts?.[i])
          $(`#prompt-${id}`).value = config.prompts[i];
    }
    match = null;
    lockPrompts(false);
    setFighters(readFighters());
    $("#series-results").hidden = true;
    $("#live-badge").textContent = "ОЖИДАНИЕ";
    $("#battle-dot").classList.remove("running");
    frames = [{ state, events: [], decisions: {} }];
    $("#mode-label").textContent = "ПРЕДПРОСМОТР КАРТЫ";
    $("#mode-label").title =
      `Игра v${config.appVersion} · правила ${config.version}`;
    $("#seed-label").textContent = state.seed;
    $("#battle-status").textContent = "Арена готова";
    render(0);
  } catch (e) {
    setMessage(e.message);
  }
}
async function start(series = false) {
  try {
    if (!$("#seed").value.trim()) throw new Error("Введите seed карты");
    if (!$("#prompt-a").value.trim() || !$("#prompt-b").value.trim())
      throw new Error("Заполните стратегии обоих бойцов");
    setFighters(readFighters(), { fields: true });
    saveDraft();
    setMessage("");
    stop();
    busy(true);
    launching = true;
    progress = { turn: 1, startedAt: Date.now(), agents: {} };
    trace = [];
    stream?.close();
    jobData = null;
    updateMonitor();
    $("#battle-status").textContent = "Запускаю бой…";
    $("#battle-dot").classList.add("running");
    if (innerWidth < 1000)
      $("#run-progress").scrollIntoView({ behavior: "smooth", block: "start" });
    previewSeq++;
    const data = await api("/api/run", {
      mode: selectedMode(),
      model: $("#model").value,
      reasoning: $("#reasoning").value,
      seed: $("#seed").value,
      prompts: [$("#prompt-a").value, $("#prompt-b").value],
      fighters: readFighters(),
      swap: $("#swap").checked,
      series,
    });
    job = data.id;
    followLive = true;
    launching = false;
    jobData = null;
    match = null;
    $("#series-results").hidden = true;
    await poll();
    if (job) connectStream(job);
    play();
    sound.confirm();
  } catch (e) {
    launching = false;
    updateMonitor();
    busy(false);
    setMessage(e.message);
  }
}
function loadMatch(m, { rewind = false } = {}) {
  const changed = match?.id !== m.id;
  if (changed) promptEditor.close();
  const ended =
    m.status !== "running" && (changed || match?.status === "running");
  if (ended) telemetryView = "analysis";
  else if (changed) telemetryView = "messages";
  match = m;
  frames = m.frames;
  lockPrompts(true);
  $("#seed-label").textContent = m.seed;
  $("#mode-label").textContent =
    m.mode === "codex"
      ? `${m.model} · ${m.reasoning ?? "low"}${m.version === "arena/1" ? " · прежние правила" : ""}`
      : "ТРЕНИРОВКА · ВСТРОЕННЫЕ БОТЫ";
  $("#mode-label").title =
    `Игра ${m.appVersion ? `v${m.appVersion}` : "до введения версий"} · правила ${m.version}`;
  $("#live-badge").textContent =
    m.status === "running" ? "● БОЙ ИДЁТ" : "● ЗАПИСЬ";
  if (changed || rewind) {
    $("#seed").value = m.seed;
    $("#swap").checked = m.swap;
    setFighters(m.fighters, { fields: true });
    $("#prompt-a").value = m.prompts[0];
    $("#prompt-b").value = m.prompts[1];
    selectModel(
      m.mode === "training" ? "training" : m.model,
      m.reasoning ?? "low",
    );
    render(followLive ? frames.length - 1 : 0, false);
  } else {
    if (followLive && index < frames.length - 1)
      render(frames.length - 1, true);
    const f = index;
    $("#timeline").max = frames.length - 1;
    $("#frame-label").textContent =
      `${String(f).padStart(2, "0")} / ${String(frames.length - 1).padStart(2, "0")}`;
    $("#next").disabled = index >= frames.length - 1;
    $("#play").disabled = frames.length <= 1 && !job;
  }
  renderAnalysis();
}
async function poll() {
  if (!job || pollInFlight) return;
  pollInFlight = true;
  clearTimeout(pollTimer);
  try {
    jobData = await api(`/api/jobs/${job}`);
    if (jobData.progress) progress = jobData.progress;
    else if (jobData.thinking && jobData.thinking !== progress?.turn)
      progress = { turn: jobData.thinking, startedAt: Date.now(), agents: {} };
    mergeTrace(jobData.trace);
    const updated = followLive
      ? jobData.matches.at(-1)
      : jobData.matches.find((m) => m.id === match?.id) ||
        (!match ? jobData.matches[0] : null);
    if (updated) loadMatch(updated);
    $("#battle-dot").classList.toggle("running", jobData.status === "running");
    if (match?.series === jobData.id) renderSeries(jobData.matches);
    if (jobData.status === "running") {
      pollTimer = setTimeout(poll, 900);
    } else {
      job = null;
      stream?.close();
      stream = null;
      busy(false);
      $("#live").hidden = true;
      $("#live-badge").textContent = "● ЗАПИСЬ";
      if (jobData.error) setMessage(jobData.error);
      if (jobData.status === "cancelled")
        setMessage("Запуск остановлен. Рассчитанные ходы сохранены.");
      await loadArchive();
    }
  } catch (e) {
    setMessage(
      `Не удалось получить состояние: ${e.message}. Повторная попытка через 3 секунды.`,
    );
    pollTimer = setTimeout(poll, 3000);
  } finally {
    pollInFlight = false;
    updateMonitor();
  }
}
const formatCount = (value) =>
  value == null ? "—" : Number(value).toLocaleString("ru-RU");
function tokenLabel(usage) {
  if (!usage || usage.total === null) return "нет данных";
  return `${usage.missing || usage.scope === "saved_turns_only" ? "≥ " : ""}${formatCount(usage.total)}`;
}
function comparisonTable(fighters, labels = names) {
  const rows = [
    ["Попадания / выстрелы", (s) => `${s.hits} / ${s.hits + s.misses}`],
    ["Урон", (s) => s.damage],
    ["Ходы с очками зоны", (s) => s.controlTurns],
    ["Ошибки / столкновения", (s) => `${s.invalid} / ${s.collisions}`],
    ["Ожидание вне зоны", (s) => s.waitsOutsideZone],
  ];
  return `<table class="analysis-table"><thead><tr><th scope="col">Показатель</th><th scope="col">${escape(labels.A)}</th><th scope="col">${escape(labels.B)}</th></tr></thead><tbody>${rows.map(([label, value]) => `<tr><th scope="row">${label}</th><td>${value(fighters.A)}</td><td>${value(fighters.B)}</td></tr>`).join("")}</tbody></table>`;
}
let analysisSignature = "",
  usageSignature = "";
function renderAnalysis() {
  if (!match || match.status === "running") return;
  const signature = JSON.stringify([
    match.id,
    match.status,
    frames.length,
    names,
  ]);
  if (signature === analysisSignature) return;
  analysisSignature = signature;
  const analysis = analyzeMatch(match);
  const outcome = analysis.outcome;
  const resultText = !outcome
    ? "Бой прерван: итог по сыгранным ходам."
    : !outcome.winner
      ? "Ничья."
      : `${names[outcome.winner]} побеждает · ${{ survival: "здоровье", control: "контроль", hp: "здоровье", harvested: "собранная энергия" }[outcome.metric]} ${outcome.score.join(" : ")}.`;
  const notes = ["A", "B"].flatMap((id) => {
    const s = analysis.fighters[id],
      hints = [];
    if (s.misses > s.hits && s.misses >= 2)
      hints.push(
        `промахов ${s.misses} — уточни в стратегии, когда стрелять и как учитывать движение цели`,
      );
    if (s.waitsOutsideZone >= 3)
      hints.push(
        `ожиданий вне зоны ${s.waitsOutsideZone} — задай следующую цель при потере противника`,
      );
    if (s.invalid + s.collisions > 0)
      hints.push(
        `ошибок и столкновений ${s.invalid + s.collisions} — проверь эти ходы в хронике`,
      );
    if (!s.controlTurns && analysis.turns >= 16 && outcome?.winner !== id)
      hints.push(
        "ни одного очка зоны — добавь запасную цель, когда преследование не даёт результата",
      );
    return hints
      .slice(0, 2)
      .map((hint) => `<li><b>${escape(names[id])}:</b> ${hint}.</li>`);
  });
  $("#analysis-panel").innerHTML =
    `<h2>${match.status === "complete" ? "Разбор боя" : "Разбор сыгранных ходов"}</h2><p class="analysis-outcome">${escape(resultText)}</p>${comparisonTable(analysis.fighters)}<p class="analysis-note">Ожидание вне зоны — действие «ждать» без занятия зоны. Само по себе не означает ошибку.</p>${notes.length ? `<h3>Что проверить в стратегии</h3><ul class="analysis-hints">${notes.join("")}</ul>` : ""}<h3>Ключевые моменты</h3><div class="key-moments">${analysis.moments.length ? analysis.moments.map((m) => `<button type="button" data-frame="${m.frame}"><span>Ход ${m.turn}</span><strong>${m.actor ? `${escape(names[m.actor])} · ` : ""}${m.text} ↗</strong></button>`).join("") : '<p class="analysis-note">Пока нет ключевых событий.</p>'}</div>`;
  $("#analysis-panel")
    .querySelectorAll("[data-frame]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        stop();
        followLive = false;
        render(Number(button.dataset.frame), true);
      }),
    );
}
function renderUsage() {
  const box = $("#usage-panel");
  box.hidden = !match || launching;
  if (box.hidden) return;
  const usage = matchUsage(match);
  const signature = JSON.stringify([
    match.id,
    match.status,
    usage,
    index,
    names,
  ]);
  if (signature === usageSignature) return;
  usageSignature = signature;
  $("#usage-summary").textContent =
    match.mode === "training"
      ? "Тренировка · без токенов"
      : `Токены · ${tokenLabel(usage)}`;
  if (match.mode === "training") {
    $("#usage-details").textContent = "Встроенные боты не обращаются к модели.";
    return;
  }
  const cell = (u, key) =>
    `${u[key] !== null && u.fieldsReported[key] < u.requests ? "≥ " : ""}${formatCount(u[key])}`;
  const rows = [
    ["Вход", "input"],
    ["Из них кэш", "cached"],
    ["Выход", "output"],
    ["Из него reasoning", "reasoning"],
  ];
  const turn = frames[index]?.state.turn;
  const calls = usageRequests(match).filter((r) => r.turn === turn);
  $("#usage-details").innerHTML =
    `<table class="analysis-table"><thead><tr><th scope="col">За весь бой</th><th scope="col">${escape(names.A)}</th><th scope="col">${escape(names.B)}</th></tr></thead><tbody>${rows.map(([label, key]) => `<tr><th scope="row">${label}</th><td>${cell(usage.fighters.A, key)}</td><td>${cell(usage.fighters.B, key)}</td></tr>`).join("")}<tr><th scope="row">Всего</th><td>${tokenLabel(usage.fighters.A)}</td><td>${tokenLabel(usage.fighters.B)}</td></tr>${turn ? `<tr><th scope="row">На ходу ${turn}</th>${["A", "B"].map((id) => `<td>${tokenLabel(aggregateUsage(calls.filter((r) => r.agent === id)))}</td>`).join("")}</tr>` : ""}</tbody></table><p class="analysis-note">Расход получен для ${usage.reported} из ${usage.requests} запросов.${usage.pending ? ` В работе: ${usage.pending}.` : ""}${usage.missing - usage.pending > 0 ? ` Без данных: ${usage.missing - usage.pending}.` : ""}${usage.scope === "saved_turns_only" ? " Старая запись: учтены только сохранённые ходы." : ""} Кэш входит во вход, reasoning — в выход. Стоимость пока не рассчитывается.</p>`;
}
function renderSeries(matches) {
  const box = $("#series-results");
  box.hidden = false;
  const complete = matches.filter((m) => m.status === "complete"),
    wins = { A: 0, B: 0, draw: 0 };
  for (const m of complete)
    wins[m.frames.at(-1).state.result.winner || "draw"]++;
  const stats = seriesStats(matches);
  const seriesNames = Object.fromEntries(
    ["A", "B"].map((id) => [id, fighterName(matches[0], id)]),
  );
  const comparisonOpen = box.querySelector("details")?.open;
  box.innerHTML = `<h3>Серия · ${complete.length} / 4 <span class="tiny">${escape(seriesNames.A)} ${wins.A} : ${wins.B} ${escape(seriesNames.B)} · НИЧЬИ ${wins.draw}</span></h3>${matches.map((m, i) => `<button data-match="${m.id}"><span>0${i + 1} · ${escape(m.seed)}${m.swap ? " · обмен стартами" : ""}</span><strong>${m.status === "complete" ? (m.frames.at(-1).state.result.winner ? escape(fighterName(m, m.frames.at(-1).state.result.winner)) : "Ничья") : m.status === "running" ? "Идёт бой…" : m.status === "error" ? "Ошибка" : "Остановлен"} ↗</strong></button>`).join("")}`;
  box.insertAdjacentHTML(
    "beforeend",
    `<details class="series-comparison"${comparisonOpen ? " open" : ""}><summary>Сравнение стратегий · ${tokenLabel(stats.usage)} токенов</summary>${comparisonTable(stats.fighters, seriesNames)}<p class="analysis-note">${stats.completed} завершённых боёв · две карты с обменом стартами. Маленькая выборка; для повторной проверки запустите серию на другом seed.</p></details>`,
  );
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      stop();
      loadMatch(
        matches.find((m) => m.id === b.dataset.match),
        { rewind: true },
      );
      play();
    }),
  );
}
async function loadArchive() {
  try {
    const list = await api("/api/matches");
    $("#archive-count").textContent = list.length;
    $("#archive-list").innerHTML = list.length
      ? list
          .map(
            (m) =>
              `<article class="archive-card"><div><h2>${m.result?.winner ? `${escape(fighterName(m, m.result.winner))} побеждает` : m.status === "complete" ? "Ничья" : m.status === "running" ? "Бой идёт" : "Незавершённый бой"}</h2><p>${escape(new Date(m.created).toLocaleString("ru-RU"))}</p></div><div><p>${m.mode === "codex" ? "CODEX" : "ТРЕНИРОВКА"} · ${escape(m.model)}${m.mode === "codex" ? ` · ${escape(m.reasoning ?? "low")}` : ""}<br>${escape(m.seed)}${m.swap ? " · ОБМЕН СТАРТАМИ" : ""}</p></div><div><p>${m.turns} / 40 ХОДОВ${m.mode === "codex" ? `<br>Токены: ${tokenLabel(m.usage)}` : ""}${m.series ? "<br>МАТЧ СЕРИИ" : ""}</p></div><button class="secondary" data-replay="${m.id}">Смотреть ↗</button></article>`,
          )
          .join("")
      : '<div class="archive-empty">Здесь будут твои бои. Начни первый на вкладке «Арена».</div>';
    $$("[data-replay]").forEach((b) =>
      b.addEventListener("click", async () => {
        try {
          stop();
          const m = await api(`/api/matches/${b.dataset.replay}`);
          loadMatch(m, { rewind: true });
          $("#prompt-a").value = m.prompts[0];
          $("#prompt-b").value = m.prompts[1];
          $("#seed").value = m.seed;
          $("#swap").checked = m.swap;
          selectModel(
            m.mode === "training" ? "training" : m.model,
            m.reasoning ?? "low",
          );
          showTab("arena");
          $("#battle-status").textContent = "Сохранённый бой";
          $("#series-results").hidden = true;
          if (m.series) {
            const saved = await api(`/api/series/${m.series}`);
            if (match?.id === m.id) renderSeries(saved.matches);
          }
          play();
        } catch (e) {
          setMessage(e.message);
          showTab("arena");
        }
      }),
    );
  } catch (e) {
    setMessage(e.message);
  }
}
$$("[data-avatar]").forEach((button) =>
  button.addEventListener("click", async () => {
    const id = button.dataset.avatar.toUpperCase(),
      old = fighters;
    const own = fighters.find((f) => f.id === id),
      other = fighters.find((f) => f.id !== id);
    const available = AVATARS.map((a) => a.id).filter(
      (a) => a !== other.avatar,
    );
    const next =
      available[(available.indexOf(own.avatar) + 1) % available.length];
    const updated = fighters.map((f) =>
      f.id === id ? { ...f, avatar: next } : f,
    );
    const matchId = match?.id;
    button.disabled = true;
    setFighters(updated);
    try {
      if (matchId) {
        const saved = await api(`/api/matches/${matchId}/avatar`, {
          agent: id,
          avatar: next,
        });
        if (match?.id === matchId) {
          match.fighters = saved.fighters;
          setFighters(saved.fighters);
        }
      }
      saveDraft();
    } catch (e) {
      if (match?.id === matchId) {
        setFighters(old);
      }
      setMessage(e.message);
    } finally {
      button.disabled = false;
    }
  }),
);
$("#run").addEventListener("click", () => start());
$("#series").addEventListener("click", () => start(true));
$("#cancel").addEventListener("click", async () => {
  if (job) {
    $("#cancel").disabled = true;
    try {
      await api(`/api/jobs/${job}/cancel`, {});
      setMessage("Останавливаю бойцов…");
    } catch (e) {
      setMessage(e.message);
      $("#cancel").disabled = false;
    }
  }
});
$("#prev").addEventListener("click", () => {
  stop();
  render(index - 1);
});
$("#next").addEventListener("click", () => {
  stop();
  render(index + 1, true);
});
$("#play").addEventListener("click", () => (playing ? stop() : play()));
$("#timeline").addEventListener("input", () => {
  stop();
  render(Number($("#timeline").value));
});
$("#speed").addEventListener("change", () => {
  if (playing) {
    clearTimeout(timer);
    tick();
  }
});
$$("[data-pov]").forEach((b) =>
  b.addEventListener("click", () => {
    pov = b.dataset.pov;
    $$("[data-pov]").forEach((el) => el.classList.toggle("selected", el === b));
    render(index);
  }),
);
$("#live").addEventListener("click", () => {
  const latest = jobData?.matches.at(-1);
  if (latest) {
    followLive = true;
    loadMatch(latest);
    render(frames.length - 1, true);
    play();
  }
});
$("#download").addEventListener("click", () => {
  if (!match) return;
  const blob = new Blob([JSON.stringify(match, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `arena-${match.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#refresh-archive").addEventListener("click", loadArchive);
$("#model").addEventListener("change", () => {
  selectModel($("#model").value, $("#reasoning").value);
  saveDraft();
});
$("#reasoning").addEventListener("change", saveDraft);
$("#random-seed").addEventListener("click", () => {
  $("#seed").value =
    `sector-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 5)}`;
  saveDraft();
  preview();
});
$("#seed").addEventListener("change", () => {
  saveDraft();
  preview();
});
$("#swap").addEventListener("change", () => {
  saveDraft();
  preview();
});
document.addEventListener("click", (event) => {
  const settings = $(".map-settings");
  if (!settings.contains(event.target)) settings.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $(".map-settings").open) {
    $(".map-settings").open = false;
    $(".map-settings summary").focus();
  }
});
for (const id of ["a", "b"]) {
  const field = $(`#prompt-${id}`);
  field.addEventListener("click", () => promptEditor.open(id));
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      promptEditor.open(id);
    }
  });
}
$$("[data-reset]").forEach((b) =>
  b.addEventListener("click", () => {
    $(b.dataset.reset === "0" ? "#prompt-a" : "#prompt-b").value =
      config.prompts[Number(b.dataset.reset)];
    saveDraft();
  }),
);
for (const id of ["a", "b"]) {
  $(`#fighter-name-${id}`).addEventListener("change", () => {
    saveDraft();
    void preview();
  });
}
$$("[data-edit-prompt]").forEach((button) =>
  button.addEventListener("click", async () => {
    if (job || launching) return;
    await preview();
    $(`#prompt-${button.dataset.editPrompt}`).focus();
    promptEditor.open(button.dataset.editPrompt);
  }),
);
window.addEventListener("keydown", (e) => {
  if (
    $("#prompt-dialog").open ||
    /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) ||
    $("#arena-tab").hidden ||
    $(".playback").hidden
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    playing ? stop() : play();
  }
  if (e.code === "ArrowLeft") {
    stop();
    render(index - 1);
  }
  if (e.code === "ArrowRight") {
    stop();
    render(index + 1, true);
  }
});
try {
  config = await api("/api/config");
  $("#app-version").textContent = `v${config.appVersion}`;
  $(".brand").setAttribute(
    "aria-label",
    `PromptCore Arena v${config.appVersion}`,
  );
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem("arena-draft"));
  } catch {}
  setFighters(draft?.fighters || randomizeAvatars(), { fields: true });
  for (const [i, id] of ["a", "b"].entries()) {
    const saved = draft?.prompts?.[i];
    $(`#prompt-${id}`).value =
      saved == null || saved === config.legacyPrompts?.[i]
        ? config.prompts[i]
        : saved;
  }
  $("#seed").value = draft?.seed || "sector-07";
  $("#swap").checked = draft?.swap === true;
  selectModel(
    draft?.mode === "training" || !config.codex.available
      ? "training"
      : draft?.model || config.codex.model,
    draft?.reasoning || config.codex.reasoning || "low",
  );
  $("#model-footer").textContent =
    `${config.appVersion} / ${config.codex.version ?? "ТРЕНИРОВКА"} / ${config.version}`;
  updateMode();
  await preview();
  await loadArchive();
  if (config.active) {
    job = config.active;
    followLive = true;
    busy(true);
    await poll();
    if (job) connectStream(job);
    play();
  }
} catch (e) {
  setMessage(`Приложение недоступно: ${e.message}`);
}
