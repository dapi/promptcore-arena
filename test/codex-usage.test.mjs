import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { codexDecision } from "../src/agents.mjs";

test("CLI usage survives invalid output, nonzero exit and cancellation while stdout drains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-fake-cli-"));
  const path = process.env.PATH;
  const usage = {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 12,
    reasoning_output_tokens: 2,
  };
  const observation = {
    legalActions: [{ choice: 0, action: "wait", target: null }],
  };
  try {
    process.env.PATH = dir + delimiter + path;
    for (const kind of ["invalid", "failure", "cancelled"]) {
      const records =
        [
          { type: "thread.started", thread_id: "fixture-thread" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "not json" },
          },
          { type: "turn.completed", usage },
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n";
      await writeFile(
        join(dir, "codex"),
        `#!${process.execPath}\nprocess.stdin.resume();\nprocess.on("SIGTERM", () => {});\nprocess.stdout.write(${JSON.stringify(records)}, () => { ${kind === "cancelled" ? "setInterval(() => {}, 1000)" : `process.exit(${kind === "failure" ? 2 : 0})`} });\n`,
        { mode: 0o700 },
      );
      const controller = new AbortController(),
        received = [];
      const decision = codexDecision(observation, "fixture", "", {
        model: "fixture",
        signal: controller.signal,
        onUsage: (r) => {
          received.push(r);
          if (kind === "cancelled") controller.abort();
        },
      });
      if (kind === "invalid") {
        const result = await decision;
        assert.equal(result.action, "invalid");
        assert.deepEqual(result.usage, usage);
      } else
        await assert.rejects(
          decision,
          kind === "cancelled" ? /остановлен/ : /не завершил/,
        );
      assert.deepEqual(received, [{ usage, threadId: "fixture-thread" }]);
    }
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});
