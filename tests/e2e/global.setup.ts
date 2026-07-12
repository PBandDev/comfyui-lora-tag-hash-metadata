import { test as setup } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eConfig } from "../../e2e.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
const workspaceDir = resolve(projectRoot, e2eConfig.workspaceDir);
const pidFile = resolve(projectRoot, e2eConfig.pidFile);
const logFile = resolve(projectRoot, e2eConfig.logFile);
const comfyBinary =
  process.platform === "win32"
    ? resolve(projectRoot, e2eConfig.venvDir, "Scripts", "comfy.exe")
    : resolve(projectRoot, e2eConfig.venvDir, "bin", "comfy");

async function isReady() {
  try {
    const response = await fetch(`${e2eConfig.baseUrl}/api/object_info`);
    return response.ok;
  } catch {
    return false;
  }
}

function processLooksLikeComfy(pid: number): boolean {
  try {
    const output =
      process.platform === "win32"
        ? execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
            encoding: "utf8",
          })
        : execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return /python|comfy/i.test(output);
  } catch {
    return false;
  }
}

function stopExistingServer(): boolean {
  if (!existsSync(pidFile)) {
    return false;
  }

  const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (Number.isNaN(pid)) {
    unlinkSync(pidFile);
    return false;
  }

  // PIDs get reused: a stale pidfile must never let us kill an unrelated
  // process. If it no longer looks like our server, just drop the pidfile.
  if (!processLooksLikeComfy(pid)) {
    unlinkSync(pidFile);
    return false;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    // Ignore already-exited processes and continue with a fresh launch.
  }

  if (existsSync(pidFile)) {
    unlinkSync(pidFile);
  }
  return true;
}

// The sidecar setup-e2e-packs.mjs seeded is the on-disk truth for a synthetic
// fixture's hash — gating on the EXACT value catches LM serving a stale
// SQLite row after a fixture edit, which "sha256 is non-empty" would miss.
function sidecarSha(dir: string, name: string): string | null {
  try {
    const sidecar = resolve(workspaceDir, "models", dir, `${name}.metadata.json`);
    const parsed = JSON.parse(readFileSync(sidecar, "utf8")) as { sha256?: string };
    return typeof parsed.sha256 === "string" && parsed.sha256.length > 0 ? parsed.sha256 : null;
  } catch {
    return null;
  }
}

async function waitForLoraManagerScan(baseURL: string): Promise<void> {
  // Pin on sha-locked fixtures — any cached row is not proof the scan
  // surfaced OUR files. The checkpoint/embedding fixtures are synthetic
  // (setup-e2e-packs.mjs) with pre-seeded sidecar hashes, so sha256 must
  // match the sidecar exactly on first scan.
  const gates = [
    { kind: "loras", file: "fisheye_slider_v10", sha: null as string | null },
    { kind: "checkpoints", file: "clth_ckpt_fixture", sha: sidecarSha("checkpoints", "clth_ckpt_fixture") },
    { kind: "embeddings", file: "clth_embed_fixture", sha: sidecarSha("embeddings", "clth_embed_fixture") },
  ];
  const pending = new Set(gates);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && pending.size > 0) {
    for (const gate of [...pending]) {
      try {
        const response = await fetch(
          `${baseURL}/api/lm/${gate.kind}/list?search=${gate.file}&fuzzy=true&fuzzy_search=true&page_size=10`,
        );
        if (response.ok) {
          const data = (await response.json()) as {
            items?: { file_name?: string; sha256?: string }[];
          };
          const surfaced = data.items?.some(
            (item) =>
              item.file_name === gate.file &&
              (item.sha256 ?? "") !== "" &&
              (gate.sha === null || item.sha256 === gate.sha),
          );
          if (surfaced === true) pending.delete(gate);
        }
      } catch {
        // server still warming up — keep polling
      }
    }
    if (pending.size > 0) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
  }
  if (pending.size > 0) {
    const missing = [...pending].map((gate) => `${gate.kind}/${gate.file}`).join(", ");
    throw new Error(
      `LoRA Manager scan did not surface fixtures within 120s (stale-cache sha mismatch also lands here): ${missing}`,
    );
  }
}

async function waitForReady() {
  const startedAt = Date.now();

  while (Date.now() - startedAt < e2eConfig.timeouts.startupMs) {
    if (await isReady()) {
      return;
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }

  const logOutput = existsSync(logFile) ? readFileSync(logFile, "utf8") : "No ComfyUI log output.";
  throw new Error(
    `ComfyUI did not become ready within ${e2eConfig.timeouts.startupMs}ms.\n${logOutput}`,
  );
}

setup("start repo-local ComfyUI for e2e", async () => {
  // Server startup (up to startupMs) + LM scan gate (up to 120s) both run in
  // this one test — the global 60s timeout would kill cold starts.
  setup.setTimeout(e2eConfig.timeouts.startupMs + 150_000);
  if (!existsSync(comfyBinary)) {
    throw new Error(
      "Missing repo-local comfy-cli. Run `pnpm setup:e2e` before Playwright starts.",
    );
  }

  const killedPrevious = stopExistingServer();
  if (killedPrevious) {
    // Give the OS a moment to release the port after the forced kill.
    for (let i = 0; i < 10 && (await isReady()); i++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  if (await isReady()) {
    throw new Error(
      `Another server is already listening on ${e2eConfig.baseUrl} — refusing to run e2e ` +
        "against it. Stop it or set COMFYUI_E2E_PORT to a free port.",
    );
  }

  mkdirSync(resolve(projectRoot, e2eConfig.workspaceDir), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });
  rmSync(logFile, { force: true });

  const logFd = openSync(logFile, "a");
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
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    },
  );

  if (child.pid === undefined) {
    throw new Error("Failed to start ComfyUI for E2E tests.");
  }

  writeFileSync(pidFile, String(child.pid), "utf8");
  child.unref();
  await waitForReady();
  // The picker's Local tab issues a single /loras/list call — LM's startup
  // scan must have surfaced the fixture loras before any spec runs.
  await waitForLoraManagerScan(e2eConfig.baseUrl);
});
