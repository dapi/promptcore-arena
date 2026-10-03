import http from "node:http";
import { readFile, writeFile, mkdir, readdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  createState,
  prepareTurn,
  observe,
  resolveTurn,
  VERSION,
} from "./engine.mjs";
import {
  botDecision,
  codexDecision,
  codexStatus,
  DEFAULT_PROMPTS,
} from "./agents.mjs";

import { normalizeFighters } from "../web/fighters.js";

const web = fileURLToPath(new URL("../web/", import.meta.url));
export async function createApp({
  dataDir = resolve(".arena"),
  provider = codexDecision,
  status = codexStatus(),
} = {}) {
  const matchesDir = join(dataDir, "matches");
  await mkdir(matchesDir, { recursive: true, mode: 0o700 });
  const jobs = new Map();
  let active = null;
  function publish(job, event) {
    const entry = {...event, seq: ++job.sequence, at: Date.now()};
    job.trace.push(entry);
    if(job.trace.length > 2000) job.trace.shift();
    for(const client of job.clients) {
      if(client.destroyed || !client.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`)) {
        client.destroy(); job.clients.delete(client);
      }
    }
    return entry;
  }
  const publicJob = job => ({id:job.id,status:job.status,thinking:job.thinking,error:job.error,progress:job.progress,trace:job.trace,matches:job.matches});
  const persist = async (match) => {
    const file = join(matchesDir, `${match.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(match), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  };
  const liveMatch = (id) =>
    [...jobs.values()].some(
      (j) => j.status === "running" && j.matches.some((m) => m.id === id),
    );
  const summary = (m) => ({
    id: m.id,
    created: m.created,
    mode: m.mode,
    model: m.model,
    fighters:normalizeFighters(m.fighters),
    seed: m.seed,
    swap: m.swap,
    status:
      m.status === "running" && !liveMatch(m.id) ? "interrupted" : m.status,
    turns: m.frames.length - 1,
    result: m.frames.at(-1)?.state.result,
    series: m.series,
    error: m.error,
  });
  async function run(job, input) {
    try {
      const rounds = input.series
        ? [
            { seed: input.seed, swap: false },
            { seed: input.seed, swap: true },
            { seed: `${input.seed}-2`, swap: false },
            { seed: `${input.seed}-2`, swap: true },
          ]
        : [{ seed: input.seed, swap: input.swap }];
      for (const round of rounds) {
        if (job.controller.signal.aborted) break;
        let state = createState(round.seed, round.swap),
          memory = { A: "", B: "" };
        const match = {
          id: randomUUID(),
          created: new Date().toISOString(),
          version: VERSION,
          mode: input.mode,
          model: input.mode === "codex" ? status.model : "builtin/1",
          cliVersion: input.mode === "codex" ? status.version : null,
          seed: round.seed,
          swap: round.swap,
          prompts: input.prompts,
          fighters:normalizeFighters(input.fighters),
          status: "running",
          series: input.series ? job.id : null,
          modelEvents: [],
          frames: [{ state, events: [], decisions: {}, observations: {} }],
        };
        job.matches.push(match);
        publish(job,{type:"match_started",matchId:match.id});
        await persist(match);
        try {
          while (!state.result && !job.controller.signal.aborted) {
            const prepared = prepareTurn(state),
              observations = {
                A: observe(prepared, "A"),
                B: observe(prepared, "B"),
              };
            job.thinking = prepared.turn;
            job.progress = {turn:prepared.turn,startedAt:Date.now(),agents:{}};
            publish(job,{type:"turn_started",turn:prepared.turn,matchId:match.id,startedAt:job.progress.startedAt});
            const choices = await Promise.all(
              ["A", "B"].map(async (id, i) => {
                const start = Date.now();
                const report = event => {
                  const entry = publish(job,{...event,type:"agent",agent:id,turn:prepared.turn,matchId:match.id});
                  job.progress.agents[id] = {...event,startedAt:start,updatedAt:entry.at};
                  match.modelEvents.push(entry);
                };
                report({phase:"starting",text:input.mode === "codex" ? "Запускаю Codex и передаю наблюдение" : "Бот выбирает действие"});
                let decision;
                try { decision =
                  input.mode === "codex"
                    ? await provider(
                        observations[id],
                        input.prompts[i],
                        memory[id],
                        { model: status.model, signal: job.controller.signal, onEvent:report },
                      )
                    : botDecision(observations[id], i ? "hunt" : "control");
                report({phase:"ready",text:decision.reason,action:decision.action,elapsedMs:Date.now()-start});
                } catch(error) {
                  report({phase:job.controller.signal.aborted?"cancelled":"error",text:error.message});
                  throw error;
                }
                return [id, { ...decision, elapsedMs: Date.now() - start }];
              }),
            );
            if (job.controller.signal.aborted) break;
            const decisions = Object.fromEntries(choices);
            for (const id of ["A", "B"]) memory[id] = decisions[id].memory;
            const frame = resolveTurn(prepared, decisions);
            state = frame.state;
            match.frames.push({ ...frame, observations, decisions });
            job.thinking = null;
            publish(job,{type:"frame",turn:state.turn,matchId:match.id});
            await persist(match);
            if (input.mode === "training")
              await new Promise((r) => setTimeout(r, 45));
          }
          match.status = state.result ? "complete" : "cancelled";
        } catch (error) {
          match.status = job.controller.signal.aborted ? "cancelled" : "error";
          match.error = error.message;
          throw error;
        } finally {
          await persist(match);
        }
      }
      job.status = job.controller.signal.aborted ? "cancelled" : "complete";
    } catch (error) {
      job.status = job.controller.signal.aborted ? "cancelled" : "error";
      job.error = error.message;
      job.controller.abort();
    } finally {
      job.thinking = null;
      active = null;
      publish(job,{type:"finished",status:job.status,error:job.error});
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref();
    }
  }
  const json = (res, code, value) => {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return json(res, 403, { error: "Только локальный доступ" });
    if (req.headers.origin && req.headers.origin !== `http://${host}`)
      return json(res, 403, { error: "Недопустимый источник запроса" });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      const url = new URL(req.url, `http://${host}`),
        path = url.pathname;
      if (path === "/api/preview" && req.method === "GET")
        return json(
          res,
          200,
          createState(
            (url.searchParams.get("seed") || "sector-07").slice(0, 80),
            url.searchParams.get("swap") === "true",
          ),
        );
      if (path === "/api/config" && req.method === "GET")
        return json(res, 200, {
          codex: status,
          prompts: DEFAULT_PROMPTS,
          version: VERSION,
          active,
        });
      if (path === "/api/matches" && req.method === "GET") {
        const files = (await readdir(matchesDir)).filter((f) =>
          f.endsWith(".json"),
        );
        const list = await Promise.all(
          files.map(async (f) => {
            try {
              return summary(
                JSON.parse(await readFile(join(matchesDir, f), "utf8")),
              );
            } catch {
              return null;
            }
          }),
        );
        return json(
          res,
          200,
          list
            .filter(Boolean)
            .sort((a, b) => b.created.localeCompare(a.created)),
        );
      }
      const idMatch = path.match(/^\/api\/matches\/([\da-f-]{36})$/);
      if (idMatch && req.method === "GET") {
        try {
          const m = JSON.parse(
            await readFile(join(matchesDir, `${idMatch[1]}.json`), "utf8"),
          );
          if (m.status === "running" && !liveMatch(m.id))
            m.status = "interrupted";
          return json(res, 200, m);
        } catch {
          return json(res, 404, { error: "Матч не найден" });
        }
      }
      const jobMatch = path.match(/^\/api\/jobs\/([\da-f-]{36})(\/(?:cancel|events))?$/);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) return json(res, 404, { error: "Запуск не найден" });
        if (jobMatch[2] === "/events" && req.method === "GET") {
          res.writeHead(200,{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform","Connection":"keep-alive","X-Accel-Buffering":"no"});
          res.flushHeaders();
          const last=Number(req.headers["last-event-id"] || 0);
          for(const event of job.trace) if(event.seq>last)res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          res.write(`event: status\ndata: ${JSON.stringify({status:job.status,progress:job.progress})}\n\n`);
          job.clients.add(res);
          const heartbeat=setInterval(()=>res.write(": heartbeat\n\n"),10000);heartbeat.unref();
          req.on("close",()=>{clearInterval(heartbeat);job.clients.delete(res);});
          return;
        }
        if (jobMatch[2] === "/cancel" && req.method === "POST") {
          job.controller.abort();
          return json(res, 200, { status: "cancelling" });
        }
        if (!jobMatch[2] && req.method === "GET")
          return json(res, 200, publicJob(job));
      }
      if (path === "/api/run" && req.method === "POST") {
        if (active)
          return json(res, 409, {
            error: "Дождитесь текущего боя или остановите его",
          });
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "Нужен JSON" });
        req.setEncoding("utf8");
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 20000)
            return json(res, 413, { error: "Слишком длинные промпты" });
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          return json(res, 400, { error: "Некорректный JSON" });
        }
        if (
          !["training", "codex"].includes(input.mode) ||
          !Array.isArray(input.prompts) ||
          input.prompts.length !== 2 ||
          input.prompts.some(
            (p) => typeof p !== "string" || !p.trim() || p.length > 6000,
          ) ||
          typeof input.seed !== "string" ||
          !input.seed.trim() ||
          input.seed.length > 80 ||
          (input.series !== undefined && typeof input.series !== "boolean") ||
          (input.swap !== undefined && typeof input.swap !== "boolean")
        )
          return json(res, 400, {
            error:
              "Проверьте два промпта (до 6000 символов) и seed (до 80 символов)",
          });
        if (input.mode === "codex" && !status.available)
          return json(res, 400, {
            error:
              "Codex недоступен. Выполните codex login и перезапустите приложение.",
          });
        if (active)
          return json(res, 409, {
            error: "Дождитесь текущего боя или остановите его",
          });
        const job = {
          id: randomUUID(),
          status: "running",
          matches: [],
          controller: new AbortController(),
          clients:new Set(),trace:[],sequence:0,progress:null,
        };
        jobs.set(job.id, job);
        active = job.id;
        try {
          await writeFile(
            join(dataDir, "last-prompts.json"),
            JSON.stringify(input.prompts),
            { mode: 0o600 },
          );
        } catch (error) {
          jobs.delete(job.id);
          active = null;
          throw error;
        }
        void run(job, input);
        return json(res, 202, { id: job.id });
      }
      if (req.method !== "GET")
        return json(res, 405, { error: "Метод не поддерживается" });
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/arena.js": "arena.js",
        "/fighters.js":"fighters.js",
        "/style.css": "style.css",
        "/favicon.svg": "../site/favicon.svg",
        "/logo.svg": "../site/logo.svg",
      };
      if (!staticFiles[path])
        return json(res, 404, { error: "Страница не найдена" });
      const mime = {
        html: "text/html",
        js: "text/javascript",
        css: "text/css",
        svg: "image/svg+xml",
      };
      res.writeHead(200, {
        "Cache-Control":"no-cache",
        "Content-Type": `${mime[staticFiles[path].split(".").at(-1)]}; charset=utf-8`,
      });
      res.end(await readFile(join(web, staticFiles[path])));
    } catch {
      if (!res.headersSent)
        json(res, 500, {
          error:
            "Не удалось обработать запрос. Проверьте доступ к локальной папке .arena.",
        });
      else res.end();
    }
  });
  return {
    server,
    stop: () => {
      for (const j of jobs.values()) { j.controller.abort(); for(const c of j.clients)c.end(); }
      server.close();
    },
  };
}
