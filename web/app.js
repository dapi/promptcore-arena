import { Arena } from "./arena.js";
import { AVATARS, DEFAULT_FIGHTERS, normalizeFighters, avatarUrl, fighterName } from "./fighters.js";
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
    invalid: "ПРОПУСК",
  };
const icons = {
  move: "↗",
  attack: "⌖",
  miss: "⌖",
  scan: "◎",
  harvest: "ϟ",
  defend: "◇",
  trap: "✳",
  explosion: "✷",
  death: "×",
  control: "▣",
  collision: "↔",
  invalid: "!",
};
const arena = new Arena($("#battlefield"));
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
  pollInFlight = false;
let fighters=normalizeFighters(DEFAULT_FIGHTERS);
function readFighters(){return normalizeFighters(["a","b"].map(id=>({name:$(`#fighter-name-${id}`).value,avatar:$(`#avatar-${id}`).value,color:$(`#color-${id}`).value})));}
function setFighters(value,{fields=false}={}){
  fighters=normalizeFighters(value);arena.setFighters(fighters);
  for(const f of fighters){const id=f.id.toLowerCase();names[f.id]=f.name;document.documentElement.style.setProperty(`--${id}`,f.color);$(`#avatar-image-${id}`).src=avatarUrl(f);$(`#avatar-image-${id}`).dataset.avatar=f.avatar;
    if(fields){$(`#fighter-name-${id}`).value=f.name;$(`#avatar-${id}`).value=f.avatar;$(`#color-${id}`).value=f.color;}}
}
for(const id of ["a","b"])$(`#avatar-${id}`).innerHTML=AVATARS.map(v=>`<option value="${v.id}">${v.name}</option>`).join("");
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
const stageNames = {starting:"Запускаю Codex",connected:"Codex подключён",thinking:"Выбирает действие",summary:"Пришло пояснение",message:"Получен текст модели",received:"Проверяем ответ",ready:"Действие готово",error:"Ошибка",cancelled:"Остановлен"};
const clockText = ms => `${String(Math.floor(ms/60000)).padStart(2,"0")}:${String(Math.floor(ms/1000)%60).padStart(2,"0")}`;
let monitorSignature = "";
function updateMonitor() {
  const running = launching || Boolean(job);
  $("#run-progress").hidden = !running;
  const elapsed = Math.max(0,Date.now()-(progress?.startedAt||Date.now()));
  $("#progress-clock").textContent = clockText(elapsed);
  const current = jobData?.matches.at(-1);
  const turn = progress?.turn || jobData?.thinking || 1;
  $("#progress-title").textContent = launching ? "Запускаю бой…" : `Бой идёт · рассчитывается ход ${turn}`;
  const done = Object.values(progress?.agents||{}).filter(a=>a.phase==="ready").length;
  $("#progress-detail").textContent = launching ? "Передаю стратегии бойцам" : done===1 ? "Один боец ответил. Ожидаем второго — ход выполняется одновременно." : elapsed>45000 ? "Ответ занимает больше обычного. Продолжаем ждать Codex, предел — 90 секунд." : "Codex обычно отвечает за 15–20 секунд. Сообщения бойцов появляются справа.";
  $("#progress-count").textContent = `${current?.frames.length-1 || 0} / 40 ходов`;
  $("#battle-progress").value = current?.frames.length-1 || 0;
  const visibleTrace = running ? trace : (match?.modelEvents || []).filter(e=>e.turn===frames[index]?.state.turn);
  $("#model-monitor").hidden = !running && match?.mode!=="codex";
  $(".monitor-title h2").textContent = running ? "Сейчас в Codex" : "Сообщения этого хода";
  $("#stream-status").textContent = running ? streamState : "ЗАПИСЬ";
  const signature = JSON.stringify([running,pov,turn,visibleTrace.length,visibleTrace.at(-1)?.seq,progress?.agents]);
  if (signature !== monitorSignature) {
    monitorSignature = signature;
    $("#model-agents").innerHTML = ["A","B"].map(id=>{
      const agent = running ? progress?.agents?.[id] : null;
      const hidden = pov!=="all" && pov!==id;
      const messages = visibleTrace.filter(e=>e.agent===id && ["summary","message","ready","error","cancelled"].includes(e.phase));
      const deduped = new Map();for(const e of messages)deduped.set(`${e.turn}:${e.itemId || e.seq}`,e);
      const lines = [...deduped.values()].slice(-12);
      const content = hidden ? '<p class="model-empty">Сообщения соперника скрыты в этом режиме обзора.</p>' : lines.length ? lines.map(e=>`<article><span>ХОД ${e.turn} · ${escape(stageNames[e.phase]||e.phase)}</span>${e.phase==="message"?`<details open><summary>Ответ модели</summary><pre>${escape(e.text)}</pre></details>`:`<p>${escape(e.text)}</p>`}</article>`).join("") : '<p class="model-empty">Текст ещё не получен. Это не означает, что расчёт остановился.</p>';
      return `<section class="model-agent fighter-${id.toLowerCase()} ${escape(agent?.phase||"")}"><div class="model-agent-header"><b>${id}</b> ${escape(names[id])}<time data-agent-clock="${id}"></time></div><div class="model-phase"><i></i>${escape(agent?stageNames[agent.phase]:running?"Ожидание ответа":"Сохранённый ход")}</div><div class="model-log">${content}</div></section>`;
    }).join("");
    $$(".model-log").forEach(el=>el.scrollTop=el.scrollHeight);
  }
  for(const id of ["A","B"]){const a=progress?.agents?.[id],el=$(`[data-agent-clock="${id}"]`);if(el)el.textContent=running&&a?clockText(a.elapsedMs??Math.max(0,Date.now()-a.startedAt)):"";}
}
function mergeTrace(entries) {
  const map=new Map(trace.map(e=>[e.seq,e]));for(const e of entries||[])map.set(e.seq,e);trace=[...map.values()].sort((a,b)=>a.seq-b.seq).slice(-2000);
}
function connectStream(id) {
  stream?.close();streamState="Подключение…";
  stream=new EventSource(`/api/jobs/${id}/events`);
  stream.onopen=()=>{streamState="● ПРЯМОЙ ПОТОК";updateMonitor();};
  stream.onerror=()=>{streamState="ОБНОВЛЯЕМ СТАТУС";updateMonitor();};
  stream.onmessage=({data})=>{
    let e;try{e=JSON.parse(data);}catch{return;}
    mergeTrace([e]);
    if(e.type==="turn_started" && (!progress || e.turn>=progress.turn))progress={turn:e.turn,startedAt:e.startedAt,agents:{}};
    if(e.type==="agent"){
      if(!progress || e.turn>progress.turn)progress={turn:e.turn,startedAt:e.at,agents:{}};
      if(e.turn===progress.turn)progress.agents[e.agent]={...progress.agents[e.agent],...e,startedAt:progress.agents[e.agent]?.startedAt||e.at};
    }
    updateMonitor();
    if(e.type==="frame" || e.type==="finished"){clearTimeout(pollTimer);void poll();}
  };
}
setInterval(updateMonitor,500);
window.addEventListener("pagehide",()=>stream?.close());
function saveDraft() {
  try {
    localStorage.setItem(
      "arena-draft",
      JSON.stringify({
        prompts: [$("#prompt-a").value, $("#prompt-b").value],
        seed: $("#seed").value,
        mode: $("#mode").value,
        fighters:readFighters(),
      }),
    );
  } catch {}
}
function updateMode() {
  const training = $("#mode").value === "training";
  $("#mode-note").textContent = training
    ? "Встроенные боты. Промпты в этом режиме не влияют на стратегию."
    : config?.codex.available
      ? `${config.codex.model} · подключён через Codex CLI`
      : "Codex не авторизован. Выполните codex login и перезапустите игру.";
  $("#mode-note").classList.toggle(
    "offline",
    !training && !config?.codex.available,
  );
}
function busy(value) {
  for (const el of $$(
    ".setup-panel textarea, .setup-panel select, .setup-panel input, .setup-panel button",
  ))
    el.disabled = value;
  $("#cancel").disabled = false;
  $("#cancel").hidden = !value;
  $("#run span:first-child").textContent = value
    ? "Идёт бой…"
    : "Запустить бой";
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
function stop() {
  playing = false;
  clearTimeout(timer);
  $("#play").textContent = "▶";
  $("#play").setAttribute("aria-label", "Воспроизвести повтор");
}
function play() {
  if (!frames.length) return;
  stop();
  if (index === frames.length - 1 && match?.status !== "running")
    render(0, false);
  playing = true;
  $("#play").textContent = "Ⅱ";
  $("#play").setAttribute("aria-label", "Пауза");
  tick();
}
function tick() {
  if (!playing) return;
  timer = setTimeout(
    () => {
      if (index < frames.length - 1) render(index + 1, true);
      else if (match?.status !== "running") {
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
  $("#play").disabled = frames.length <= 1;
  $("#download").disabled = !match;
  $("#live").hidden = !job;
  $("#board-overlay").hidden = Boolean(match);
  $("#result-banner").hidden = !s.result;
  if (s.result) {
    const r = s.result;
    $("#result-banner").innerHTML =
      `<span class="tiny">МАТЧ ЗАВЕРШЁН · ${s.turn} ХОДОВ</span><strong>${r.winner ? `${escape(names[r.winner])} побеждает` : "Ничья"}</strong><p>${escape(r.reason)}</p>`;
  }
  $("#battlefield").setAttribute(
    "aria-label",
    `Арена 12 на 12, ход ${s.turn}. ${s.agents
      .filter((a) => arena.visible(a.pos))
      .map((a) => `${names[a.id]}: здоровье ${a.hp}, энергия ${a.energy}`)
      .join(". ")}. Обзор: ${pov === "all" ? "вся арена" : names[pov]}.`,
  );
  $("#fighter-stats").innerHTML = s.agents
    .map((a) => {
      const visible = arena.visible(a.pos),
        own = pov === "all" || pov === a.id;
      return `<div class="stat-card fighter-${a.id.toLowerCase()}"><div class="stat-title"><span><img class="stat-avatar" src="${avatarUrl(fighters.find(f=>f.id===a.id))}" alt="" /><b>${a.id}</b> ${escape(names[a.id])}</span><span class="tiny">${!visible ? "ВНЕ ОБЗОРА" : a.hp <= 0 ? "УНИЧТОЖЕН" : own ? actions[f.decisions?.[a.id]?.action] || "ГОТОВ" : "В ПОЛЕ ЗРЕНИЯ"}</span></div><div class="bar-label"><span>Здоровье</span><b>${visible ? a.hp : "?"} <span class="dim">/ 10</span></b></div><div class="bar"><i style="width:${visible ? a.hp * 10 : 0}%"></i></div><div class="bar-label"><span>Энергия</span><b>${visible ? a.energy : "?"} <span class="dim">/ 12</span></b></div><div class="bar energy"><i style="width:${visible ? (a.energy / 12) * 100 : 0}%"></i></div><div class="stat-bottom"><span>КОНТРОЛЬ <b>${a.control}</b></span><span>СОБРАНО <b>${own ? a.harvested : "?"}</b></span></div></div>`;
    })
    .join("");
  const events = f.events.filter(
    (e) =>
      pov === "all" ||
      e.actor === pov ||
      e.target === pov ||
      (e.pos && arena.visible(e.pos)) ||
      (e.to && arena.visible(e.to) && e.from && arena.visible(e.from)),
  );
  $("#event-count").textContent = `${events.length} СОБЫТИЙ`;
  $("#event-feed").innerHTML = events.length
    ? events
        .map(
          (e) =>
            `<div class="event ${escape(e.type)}"><span class="event-icon">${icons[e.type] || "·"}</span><div><time>ХОД ${String(s.turn).padStart(2, "0")}</time><p>${escape(e.text.replace(/\b([AB])\b/g,id=>names[id]))}</p></div></div>`,
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
    match = null;
    setFighters(readFighters());
    $("#series-results").hidden = true;
    $("#live-badge").textContent = "ОЖИДАНИЕ";
    $("#battle-dot").classList.remove("running");
    frames = [{ state, events: [], decisions: {} }];
    $("#mode-label").textContent = "ПРЕДПРОСМОТР КАРТЫ";
    $("#seed-label").textContent = state.seed.toUpperCase();
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
    saveDraft();
    setMessage("");
    stop();
    busy(true);
    launching=true;progress={turn:1,startedAt:Date.now(),agents:{}};trace=[];stream?.close();jobData=null;
    updateMonitor();
    $("#battle-status").textContent="Запускаю бой…";
    $("#battle-dot").classList.add("running");
    previewSeq++;
    const data = await api("/api/run", {
      mode: $("#mode").value,
      seed: $("#seed").value,
      prompts: [$("#prompt-a").value, $("#prompt-b").value],
      fighters:readFighters(),
      swap: $("#swap").checked,
      series,
    });
    job = data.id;
    launching=false;
    jobData = null;
    match = null;
    $("#series-results").hidden = true;
    await poll();
    connectStream(job);
    play();
  } catch (e) {
    launching=false;
    updateMonitor();
    busy(false);
    setMessage(e.message);
  }
}
function loadMatch(m, { rewind = false } = {}) {
  const changed = match?.id !== m.id;
  match = m;
  frames = m.frames;
  $("#seed-label").textContent = m.seed.toUpperCase();
  $("#mode-label").textContent =
    m.mode === "codex"
      ? `CODEX · ${m.model.toUpperCase()}`
      : "ТРЕНИРОВКА · ВСТРОЕННЫЕ БОТЫ";
  $("#live-badge").textContent =
    m.status === "running" ? "● БОЙ ИДЁТ" : "● ЗАПИСЬ";
  if (changed || rewind) {setFighters(m.fighters,{fields:true});render(0, false);}
  else {
    const f = index;
    $("#timeline").max = frames.length - 1;
    $("#frame-label").textContent =
      `${String(f).padStart(2, "0")} / ${String(frames.length - 1).padStart(2, "0")}`;
    $("#next").disabled = index >= frames.length - 1;
    $("#play").disabled = frames.length <= 1;
  }
}
async function poll() {
  if (!job || pollInFlight) return;
  pollInFlight=true;
  clearTimeout(pollTimer);
  try {
    jobData = await api(`/api/jobs/${job}`);
    if(jobData.progress)progress=jobData.progress;
    else if(jobData.thinking && jobData.thinking!==progress?.turn)progress={turn:jobData.thinking,startedAt:Date.now(),agents:{}};
    mergeTrace(jobData.trace);
    const updated =
      jobData.matches.find((m) => m.id === match?.id) || jobData.matches[0];
    if (updated) loadMatch(updated);
    $("#battle-dot").classList.toggle("running", jobData.status === "running");
    $("#battle-status").textContent =
      jobData.status === "running"
        ? jobData.thinking
          ? `Бойцы выбирают ход ${jobData.thinking}…`
          : "Бой идёт…"
        : jobData.status === "complete"
          ? "Матч рассчитан · смотри повтор"
          : jobData.status === "cancelled"
            ? "Запуск остановлен"
            : "Ошибка запуска";
    if (jobData.matches.some((m) => m.series)) renderSeries();
    if (jobData.status === "running") {
      pollTimer = setTimeout(poll, 900);
    } else {
      job = null;
      stream?.close();stream=null;
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
  } finally {pollInFlight=false;updateMonitor();}
}
function renderSeries() {
  const box = $("#series-results");
  box.hidden = false;
  const complete = jobData.matches.filter((m) => m.status === "complete"),
    wins = { A: 0, B: 0, draw: 0 };
  for (const m of complete)
    wins[m.frames.at(-1).state.result.winner || "draw"]++;
  box.innerHTML = `<h3>Серия · ${complete.length} / 4 <span class="tiny">${escape(names.A)} ${wins.A} : ${wins.B} ${escape(names.B)} · НИЧЬИ ${wins.draw}</span></h3>${jobData.matches.map((m, i) => `<button data-match="${m.id}"><span>0${i + 1} · ${escape(m.seed)}${m.swap ? " · обмен стартами" : ""}</span><strong>${m.status === "complete" ? (m.frames.at(-1).state.result.winner ? escape(fighterName(m,m.frames.at(-1).state.result.winner)) : "Ничья") : m.status === "running" ? "Идёт бой…" : m.status === "error" ? "Ошибка" : "Остановлен"} ↗</strong></button>`).join("")}`;
  box.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      stop();
      loadMatch(
        jobData.matches.find((m) => m.id === b.dataset.match),
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
              `<article class="archive-card"><div><h2>${m.result?.winner ? `${escape(fighterName(m,m.result.winner))} побеждает` : m.status === "complete" ? "Ничья" : m.status === "running" ? "Бой идёт" : "Незавершённый бой"}</h2><p>${escape(new Date(m.created).toLocaleString("ru-RU"))}</p></div><div><p>${m.mode === "codex" ? "CODEX" : "ТРЕНИРОВКА"} · ${escape(m.model)}<br>${escape(m.seed)}${m.swap ? " · ОБМЕН СТАРТАМИ" : ""}</p></div><div><p>${m.turns} / 40 ХОДОВ${m.series ? "<br>МАТЧ СЕРИИ" : ""}</p></div><button class="secondary" data-replay="${m.id}">Смотреть ↗</button></article>`,
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
          $("#mode").value = m.mode;
          updateMode();
          showTab("arena");
          $("#battle-status").textContent = "Сохранённый бой";
          $("#series-results").hidden = true;
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
    loadMatch(latest);
    render(frames.length - 1, true);
    if (!playing) play();
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
$("#mode").addEventListener("change", () => {
  updateMode();
  saveDraft();
});
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
$("#swap").addEventListener("change", preview);
$$("textarea").forEach((el) => el.addEventListener("input", saveDraft));
$$("[data-reset]").forEach((b) =>
  b.addEventListener("click", () => {
    $(b.dataset.reset === "0" ? "#prompt-a" : "#prompt-b").value =
      config.prompts[Number(b.dataset.reset)];
    saveDraft();
  }),
);
for(const id of ["a","b"]){
  for(const field of ["fighter-name","avatar","color"])$(`#${field}-${id}`).addEventListener("change",()=>{saveDraft();void preview();});
}
window.addEventListener("keydown", (e) => {
  if (
    /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) ||
    $("#arena-tab").hidden
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
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem("arena-draft"));
  } catch {}
  setFighters(draft?.fighters,{fields:true});
  $("#prompt-a").value = draft?.prompts?.[0] ?? config.prompts[0];
  $("#prompt-b").value = draft?.prompts?.[1] ?? config.prompts[1];
  $("#seed").value = draft?.seed || "sector-07";
  $("#mode").value =
    draft?.mode || (config.codex.available ? "codex" : "training");
  $("#model-footer").textContent =
    `${config.codex.version ?? "ТРЕНИРОВКА"} / ${config.version}`;
  updateMode();
  await preview();
  await loadArchive();
  if (config.active) {
    job = config.active;
    busy(true);
    await poll();
    if(job)connectStream(job);
    play();
  }
} catch (e) {
  setMessage(`Приложение недоступно: ${e.message}`);
}
