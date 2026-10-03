// Only public CLI events enter the spectator feed. Never relay stderr,
// raw reasoning payloads, credentials, or tool output.
export function publicCodexEvent(record) {
  if (record.type === "thread.started")
    return { phase: "connected", text: "Codex подключён" };
  if (record.type === "turn.started")
    return { phase: "thinking", text: "Модель выбирает действие" };
  if (record.type === "turn.completed")
    return { phase: "received", text: "Ответ модели получен" };
  if (!["item.started", "item.updated", "item.completed"].includes(record.type))
    return null;
  const item = record.item;
  if (
    !item ||
    !["agent_message", "reasoning"].includes(item.type) ||
    typeof item.text !== "string" ||
    !item.text
  )
    return null;
  return {
    phase: item.type === "reasoning" ? "summary" : "message",
    text: item.text.slice(0, 12000),
    itemId: item.id,
  };
}
export function jsonLines(onRecord) {
  let pending = "";
  const line = (text) => {
    if (!text.trim()) return;
    try {
      onRecord(JSON.parse(text));
    } catch {}
  };
  return {
    write(chunk) {
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    },
    end() {
      line(pending);
      pending = "";
    },
  };
}
