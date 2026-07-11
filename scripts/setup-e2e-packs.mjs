import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eConfig } from "../e2e.config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const comfyDir = resolve(projectRoot, e2eConfig.comfyDir);
// comfy-cli runs the server from the venv it creates INSIDE the workspace,
// not from the comfy-cli venv (e2eConfig.venvDir) — pack deps must go there.
const serverVenvDir = join(comfyDir, ".venv");
const venvPython =
  process.platform === "win32"
    ? join(serverVenvDir, "Scripts", "python.exe")
    : join(serverVenvDir, "bin", "python");
const customNodesDir = join(comfyDir, "custom_nodes");

function run(command, args, options = {}) {
  console.log(`[setup:packs] $ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: projectRoot, stdio: "inherit", ...options });
}

function ensurePinnedPacks() {
  const versions = JSON.parse(
    readFileSync(join(projectRoot, "tests", "e2e", "versions.lock.json"), "utf8"),
  );
  for (const pack of versions.packs) {
    const dest = join(customNodesDir, pack.name);
    const atPin = () => {
      try {
        const head = execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim();
        return head === pack.sha;
      } catch {
        return false;
      }
    };
    if (!existsSync(join(dest, ".git"))) {
      run("git", ["init", dest]);
      run("git", ["-C", dest, "remote", "add", "origin", pack.url]);
    }
    if (!atPin()) {
      run("git", ["-C", dest, "fetch", "--depth", "1", "origin", pack.sha]);
      run("git", ["-C", dest, "checkout", "--force", pack.sha]);
    }
    const requirements = join(dest, "requirements.txt");
    if (existsSync(requirements)) {
      run("uv", ["pip", "install", "--python", venvPython, "-r", requirements]);
    }
  }
}

function writePortableLoraManagerSettings() {
  // Keep ALL LoRA Manager state inside its clone so the harness never touches
  // the user's real %LOCALAPPDATA%\ComfyUI-LoRA-Manager settings.
  writeFileSync(
    join(customNodesDir, "ComfyUI-Lora-Manager", "settings.json"),
    JSON.stringify({ use_portable_settings: true, civitai_api_key: "" }, null, 2),
  );
}

function installHarnessNodes() {
  cpSync(join(projectRoot, "tests", "e2e", "e2e_test_nodes"), join(customNodesDir, "e2e_test_nodes"), {
    recursive: true,
  });
}

function ensureFixtures() {
  const fixtures = JSON.parse(
    readFileSync(join(projectRoot, "tests", "e2e", "fixtures.lock.json"), "utf8"),
  );
  const canonicalDir = join(projectRoot, "tests", "e2e", "fixtures", "loras");
  mkdirSync(canonicalDir, { recursive: true });
  const lorasDir = join(comfyDir, "models", "loras");
  mkdirSync(lorasDir, { recursive: true });

  for (const fixture of fixtures.loras) {
    const canonicalPath = join(canonicalDir, fixture.filename);
    const verified = () =>
      existsSync(canonicalPath) &&
      createHash("sha256").update(readFileSync(canonicalPath)).digest("hex").toUpperCase() ===
        fixture.sha256;
    if (!verified()) {
      run("curl", ["-sfL", "-o", canonicalPath, fixture.url]);
      if (!verified()) {
        throw new Error(`sha256 mismatch for ${fixture.filename}`);
      }
    }
    // COPY into the workspace: the LoRA Manager scanner writes .metadata.json
    // sidecars next to loras, and the canonical fixtures dir must stay clean.
    cpSync(canonicalPath, join(lorasDir, fixture.filename));
  }
}

ensurePinnedPacks();
writePortableLoraManagerSettings();
installHarnessNodes();
ensureFixtures();
console.log("[setup:packs] e2e packs + fixtures ready");
