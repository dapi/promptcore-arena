import test from "node:test";
import assert from "node:assert/strict";
import { publicCodexEvent, jsonLines } from "../src/codex-events.mjs";
import {
  normalizeFighters,
  randomizeAvatars,
  avatarSvg,
  avatarUrl,
  DEFAULT_FIGHTERS,
} from "../web/fighters.js";
test("CLI stream parses split JSON lines before completion and retains public summaries", () => {
  const result = [];
  const stream = jsonLines((r) => {
    const e = publicCodexEvent(r);
    if (e) result.push(e);
  });
  stream.write('{"type":"turn.sta');
  assert.equal(result.length, 0);
  stream.write('rted"}\n');
  assert.equal(result[0].phase, "thinking");
  stream.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "r", type: "reasoning", text: "Краткое пояснение" },
    }) + "\n",
  );
  assert.equal(result[1].phase, "summary");
  stream.write(
    JSON.stringify({
      type: "item.completed",
      item: { id: "m", type: "agent_message", text: '{"action":"defend"}' },
    }),
  );
  stream.end();
  assert.equal(result[2].phase, "message");
  assert.equal(
    publicCodexEvent({
      type: "item.completed",
      item: { type: "raw_reasoning", text: "hidden" },
    }),
    null,
  );
  assert.equal(
    publicCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", text: "secret" },
    }),
    null,
  );
  assert.equal(publicCodexEvent({ type: "error", message: "secret" }), null);
});
test("fighter appearance is normalized and uses one SVG for profile and canvas", () => {
  const f = normalizeFighters([
    { name: "  Искра  ", avatar: "drone", color: "#ff947f" },
    { name: "<img>", avatar: "bad", color: "red;secret" },
  ]);
  assert.equal(f[0].name, "Искра");
  assert.equal(f[1].avatar, "spectre");
  assert.equal(f[1].color, DEFAULT_FIGHTERS[1].color);
  assert.equal(f[0].color, DEFAULT_FIGHTERS[0].color);
  const randomized = randomizeAvatars(f);
  assert.notEqual(randomized[0].avatar, randomized[1].avatar);
  assert.deepEqual(
    randomized.map((f) => f.color),
    DEFAULT_FIGHTERS.map((f) => f.color),
  );
  assert.ok(
    decodeURIComponent(avatarUrl(f[0])).endsWith(
      avatarSvg("drone", DEFAULT_FIGHTERS[0].color),
    ),
  );
  assert.notEqual(
    avatarSvg("drone", "#ff947f"),
    avatarSvg("scarab", "#ff947f"),
  );
});
