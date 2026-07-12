import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

// A symlink/junction here would redirect pack checkouts, settings writes and
// fixture copies into a real ComfyUI outside the repo — refuse.
function assertNotSymlink(target, label) {
  if (!existsSync(target)) {
    return;
  }
  if (lstatSync(target).isSymbolicLink()) {
    throw new Error(`${label} (${target}) is a symlink/junction — refusing to use a redirected path.`);
  }
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
    for (let attempt = 1; attempt <= 3 && !verified(); attempt++) {
      try {
        run("curl", ["-sfL", "--retry", "2", "-o", canonicalPath, fixture.url]);
      } catch (error) {
        if (attempt === 3) throw error;
      }
    }
    if (!verified()) {
      throw new Error(`sha256 mismatch for ${fixture.filename}`);
    }
    // COPY into the workspace: the LoRA Manager scanner writes .metadata.json
    // sidecars next to loras, and the canonical fixtures dir must stay clean.
    cpSync(canonicalPath, join(lorasDir, fixture.filename));
  }
}

// Minimal valid safetensors: 8-byte LE header length + JSON header + tensor
// data. LoRA Manager's checkpoint/embedding scanners only hash the file and
// read this header, so tiny deterministic files stand in for multi-GB models.
function syntheticSafetensors(fixtureKind, tensorName) {
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: { clth_fixture: fixtureKind },
      [tensorName]: { dtype: "F32", shape: [4], data_offsets: [0, 16] },
    }),
    "utf8",
  );
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([length, header, Buffer.alloc(16)]);
}

function ensureSyntheticFixtures() {
  const synthetic = [
    { dir: "checkpoints", filename: "clth_ckpt_fixture.safetensors", kind: "checkpoint", tensor: "model.weight" },
    { dir: "embeddings", filename: "clth_embed_fixture.safetensors", kind: "embedding", tensor: "emb_params" },
  ];
  let fixturesChanged = false;
  for (const fixture of synthetic) {
    const content = syntheticSafetensors(fixture.kind, fixture.tensor);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const targetDir = join(comfyDir, "models", fixture.dir);
    mkdirSync(targetDir, { recursive: true });
    const target = join(targetDir, fixture.filename);
    if (
      !existsSync(target) ||
      createHash("sha256").update(readFileSync(target)).digest("hex") !== sha256
    ) {
      writeFileSync(target, content);
      fixturesChanged = true;
    }
    // Pre-seed the LoRA Manager sidecar with the completed hash: LM hashes
    // checkpoints LAZILY (hash_status stays "pending" until something asks),
    // and the picker e2e needs a deterministic sha256 on first scan.
    const baseName = fixture.filename.replace(/\.safetensors$/, "");
    const stats = statSync(target);
    writeFileSync(
      join(targetDir, `${baseName}.metadata.json`),
      JSON.stringify(
        {
          file_name: baseName,
          model_name: baseName,
          file_path: target.replaceAll("\\", "/"),
          size: stats.size,
          modified: stats.mtimeMs / 1000,
          sha256,
          base_model: "Unknown",
          preview_url: "",
          preview_nsfw_level: 0,
          notes: "",
          from_civitai: false,
          civitai: {},
          tags: [],
          modelDescription: "",
          civitai_deleted: false,
          favorite: false,
          exclude: false,
          db_checked: false,
          skip_metadata_refresh: false,
          metadata_source: null,
          last_checked_at: 0,
          hash_status: "completed",
          sub_type: fixture.kind,
        },
        null,
        2,
      ),
    );
    console.log(
      `[setup:packs] synthetic ${fixture.dir} fixture sha256=${sha256.toUpperCase()}`,
    );
  }
  if (fixturesChanged) {
    // LM hydrates from its SQLite snapshot on boot and never re-reads
    // sidecars for already-known paths — without this purge, edited synthetic
    // fixtures would keep serving their STALE cached sha256 forever.
    rmSync(join(customNodesDir, "ComfyUI-Lora-Manager", "cache", "model"), {
      recursive: true,
      force: true,
    });
    console.log("[setup:packs] synthetic fixtures changed — purged LM model cache");
  }
}

assertNotSymlink(resolve(projectRoot, ".e2e"), "e2e root");
assertNotSymlink(comfyDir, "e2e ComfyUI workspace");
assertNotSymlink(customNodesDir, "e2e custom_nodes dir");
ensurePinnedPacks();
writePortableLoraManagerSettings();
installHarnessNodes();
ensureFixtures();
ensureSyntheticFixtures();
console.log("[setup:packs] e2e packs + fixtures ready");
