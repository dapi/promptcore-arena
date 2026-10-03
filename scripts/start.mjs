import { execFileSync, spawn } from "node:child_process";
import { createApp } from "../src/server.mjs";
let port;
try {
  port = Number(
    process.env.PORT ||
      execFileSync("port-selector", ["--name", "web"], {
        encoding: "utf8",
      }).trim(),
  );
} catch {
  console.error(
    "Для выбора локального порта требуется port-selector. Можно также явно задать PORT.",
  );
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Неверный PORT");
const { server, stop } = await createApp();
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Порт занят. Проверьте запущенную копию игры или выделите другой порт через port-selector."
      : error.message,
  );
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`PromptCore Arena → ${url}`);
  if (!process.argv.includes("--no-open")) {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  }
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stop();
    setTimeout(() => process.exit(), 500).unref();
  });
