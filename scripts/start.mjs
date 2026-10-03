import { execFileSync, spawn } from "node:child_process";
import { createApp } from "../src/server.mjs";
let port = 0;
if (process.env.PORT !== undefined) port = Number(process.env.PORT);
else {
  try {
    port = Number(
      execFileSync("port-selector", ["--name", "web"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    // Let the OS choose a free port when port-selector is not installed.
  }
}
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Неверный PORT");
const { server, stop } = await createApp();
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? "Порт занят. Проверьте запущенную копию игры или задайте другой PORT."
      : error.message,
  );
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
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
