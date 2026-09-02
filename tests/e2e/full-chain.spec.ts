import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { e2eConfig } from "../../e2e.config.mjs";
import { readParametersText } from "./png-text";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const comfyDir = resolve(projectRoot, e2eConfig.comfyDir);
const outputDir = join(comfyDir, "output", "e2e");

const FISHEYE_AUTOV2 = "D6A3AC6F8A";

interface PromptNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

function chainPrompt(civitaiResources: string, filename: string): Record<string, PromptNode> {
  return {
    n1: { class_type: "E2EDummyModel", inputs: {} },
    n2: {
      class_type: "Lora Loader (LoraManager)",
      inputs: {
        model: ["n1", 0],
        text: "",
        loras: {
          __value__: [
            { name: "fisheye_slider_v10", strength: 1.0, active: true, clipStrength: 1.0 },
          ],
        },
      },
    },
    n3: {
      class_type: "CivitaiResourcesToHashMetadata",
      inputs: { loaded_loras: ["n2", 3], civitai_resources: civitaiResources },
    },
    n4: {
      class_type: "Image Saver Metadata",
      inputs: {
        positive: "e2e",
        negative: "",
        modelname: "",
        seed_value: 1,
        steps: 1,
        cfg: 1.0,
        sampler_name: "euler",
        scheduler_name: "normal",
        width: 64,
        height: 64,
        additional_hashes: ["n3", 0],
        custom: ["n3", 4], // lora_hashes -> A1111 `Lora hashes:` fragment
        download_civitai_data: true,
        easy_remix: true,
      },
    },
    n5: { class_type: "EmptyImage", inputs: { width: 64, height: 64, batch_size: 1, color: 0 } },
    n6: {
      class_type: "Image Saver Simple",
      inputs: {
        images: ["n5", 0],
        metadata: ["n4", 0],
        filename,
        path: "e2e",
        extension: "png",
        lossless_webp: true,
        quality_jpeg_or_webp: 100,
        optimize_png: false,
        embed_workflow: false,
        save_workflow_as_json: false,
        show_preview: false,
      },
    },
  };
}

export async function runPrompt(
  request: import("@playwright/test").APIRequestContext,
  prompt: Record<string, PromptNode>,
): Promise<void> {
  const res = await request.post(`${e2eConfig.baseUrl}/prompt`, { data: { prompt } });
  expect(res.ok(), `POST /prompt failed: ${await res.text()}`).toBe(true);
  const { prompt_id } = (await res.json()) as { prompt_id: string };
  await expect
    .poll(
      async () => {
        const h = await request.get(`${e2eConfig.baseUrl}/history/${prompt_id}`);
        const body = (await h.json()) as Record<
          string,
          { status?: { completed?: boolean; status_str?: string } }
        >;
        const entry = body[prompt_id];
        if (entry?.status?.status_str === "error") {
          return `error: ${JSON.stringify(entry.status)}`;
        }
        return entry?.status?.completed ? "done" : "pending";
      },
      { timeout: 120_000 },
    )
    .toBe("done");
}

test("LM loras readiness poll", async ({ request }) => {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${e2eConfig.baseUrl}/api/lm/loras/list?page=1`);
        if (!r.ok()) return 0;
        const body = (await r.json()) as { items?: unknown[] };
        return body.items?.length ?? 0;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2);
});

test("full chain: LM -> hash node -> Image Saver PNG credits lora fixture", async ({ request }) => {
  rmSync(outputDir, { recursive: true, force: true });
  await runPrompt(request, chainPrompt("", "e2e_result"));
  const params = readParametersText(join(outputDir, "e2e_result.png"));
  // Live API: the fixture hash is civitai-registered, so a Civitai resources JSON
  // (with modelName) is expected; the Hashes fallback still carries our AutoV2.
  expect(params.includes("Civitai resources:") || params.includes(FISHEYE_AUTOV2)).toBe(true);
  expect(params.toLowerCase()).toContain("fisheye");
  // `custom` lands verbatim in the settings line, quoted A1111 grammar intact.
  expect(params).toContain(`, Lora hashes: "fisheye_slider_v10: ${FISHEYE_AUTOV2}", `);
});

test("v2 URL box credits workflow + encoder + detailer via live api", async ({ request }) => {
  const urls = [
    "https://civitai.red/models/1362968/workflow-for-anima-and-sdxl-noobai-xlillustrious-xl",
    "https://civitai.red/models/2598886/anima-text-encoder-qwen3-06b-heretic-abliterated-uncensored",
    "https://civitai.red/models/2767064/anima-detailer?modelVersionId=3114726",
    "# a comment",
    "https://civitai.com/models/999999999", // expected missing
  ].join("\n");
  await runPrompt(request, chainPrompt(urls, "e2e_urls"));
  const params = readParametersText(join(outputDir, "e2e_urls.png"));
  // Models 1362968/2598886 are unpinned -> resolve to their CURRENT latest
  // version, so those AutoV2 constants may legitimately drift; the pinned
  // detailer version is the hard assertion.
  expect(params.includes("CD64AF8696") || params.includes("Civitai resources:")).toBe(true);
  expect(params.toLowerCase()).toContain("detailer");
  // All three example resources resolve; only the bogus model id is missing.
  expect(params).not.toContain("999999999");
  // Lora hashes = loaded lora + the pinned detailer (type LORA) only, anchored
  // to exactly two entries so the workflow / text encoder lines stay out.
  const loraHashes = /Lora hashes: "([^"]*)"/.exec(params)?.[1] ?? "";
  expect(loraHashes).toMatch(
    new RegExp(`^fisheye_slider_v10: ${FISHEYE_AUTOV2}, [^,]*detailer[^,]*: CD64AF8696$`, "i"),
  );
});
