import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eConfig } from "../e2e.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const workspaceDir = resolve(projectRoot, e2eConfig.workspaceDir);
const comfyBinary =
  process.platform === "win32"
    ? resolve(projectRoot, e2eConfig.venvDir, "Scripts", "comfy.exe")
    : resolve(projectRoot, e2eConfig.venvDir, "bin", "comfy");

if (!existsSync(comfyBinary)) {
  console.error("Missing repo-local comfy-cli. Run `pnpm setup:e2e` first.");
  process.exit(1);
}

console.log(`
  Manual e2e ComfyUI -> ${e2eConfig.baseUrl}
  (isolated from your real ComfyUI instance — Ctrl+C to stop)
`);

const child = spawn(
  comfyBinary,
  [
    "--skip-prompt",
    `--workspace=${workspaceDir}`,
    "launch",
    "--",
    "--cpu",
    "--port",
    String(e2eConfig.port),
    "--listen",
    "127.0.0.1",
  ],
  { cwd: projectRoot, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
