import { expect, test } from "@playwright/test";

interface WidgetLike {
  name: string;
  value: string | number | boolean | object;
  callback?: (value?: string) => void;
}

interface NodeLike {
  widgets?: WidgetLike[];
  inputs?: { name: string }[];
  outputs?: { name: string }[];
  connect?(slot: number, target: NodeLike, targetSlot: number): object | null;
}

interface PreviewWindow {
  app?: {
    graph?: { add(node: NodeLike): void; clear(): void; serialize?(): object };
    loadGraphData?(data: object): Promise<void> | void;
  };
  LiteGraph: { createNode(type: string): NodeLike | null };
  __previewNode?: NodeLike;
}

const PINNED_LINE = "https://civitai.com/models/2767064?modelVersionId=3114726 0.8";

async function freshNodeWithText(
  page: import("@playwright/test").Page,
  text: string,
): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    const win = window as object as PreviewWindow;
    return win.app?.graph !== undefined;
  });
  const created = await page.evaluate((value) => {
    const win = window as object as PreviewWindow;
    win.app?.graph?.clear();
    const node = win.LiteGraph.createNode("CivitaiResourcesToHashMetadata");
    if (node === null) return false;
    win.app?.graph?.add(node);
    win.__previewNode = node;
    const widget = node.widgets?.find((w) => w.name === "civitai_resources");
    if (widget === undefined) return false;
    widget.value = value;
    widget.callback?.(value);
    return true;
  }, text);
  expect(created).toBe(true);
}

function textboxValue(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const win = window as object as PreviewWindow;
    const widget = win.__previewNode?.widgets?.find((w) => w.name === "civitai_resources");
    return String(widget?.value ?? "");
  });
}

// The refresh button is a native LiteGraph widget (canvas-drawn, no DOM) —
// trigger it the same way a click would.
function clickRefresh(page: import("@playwright/test").Page): Promise<void> {
  return page.evaluate(() => {
    const win = window as object as PreviewWindow;
    win.__previewNode?.widgets?.find((w) => w.name === "⟳ Refresh resources")?.callback?.();
  });
}

test("refresh button previews the textbox without queueing a prompt", async ({ page }) => {
  await freshNodeWithText(page, `# comment\n${PINNED_LINE}`);
  await clickRefresh(page);

  const row = page.locator(".clth-row");
  await expect(row.first()).toBeVisible({ timeout: 30_000 });
  await expect(row.first()).toContainText("Anima Detailer");
  await expect(page.locator(".clth-note")).toContainText("queue a prompt");
});

test("row remove button deletes the line from the textbox", async ({ page }) => {
  await freshNodeWithText(page, PINNED_LINE);
  await clickRefresh(page);
  await expect(page.locator(".clth-row").first()).toBeVisible({ timeout: 30_000 });

  await page.locator(".clth-row .clth-x").first().click();
  await expect(page.locator(".clth-empty")).toBeVisible({ timeout: 30_000 });
  expect(await textboxValue(page)).toBe("");
});

test("picker apply updates the status list immediately", async ({ page }) => {
  await freshNodeWithText(page, "");
  await page.evaluate(() => {
    const win = window as object as PreviewWindow;
    win.__previewNode?.widgets?.find((w) => w.name === "＋ Add Resource")?.callback?.();
  });
  await expect(page.locator(".clth-pk-overlay")).toBeVisible();

  const searchResponse = page.waitForResponse(
    (response) => response.url().includes("query=anima"),
    { timeout: 30_000 },
  );
  await page.fill(".clth-pk-search", "anima detailer");
  await searchResponse;
  const card = page.locator(".clth-pk-card", { hasText: "Anima Detailer" }).first();
  await card.locator(".clth-pk-add").click();
  await page.locator(".clth-pk-apply").click();
  await expect(page.locator(".clth-pk-overlay")).toHaveCount(0);

  // No queue — rows come from the preview route.
  await expect(page.locator(".clth-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".clth-row").first()).toContainText("Anima Detailer");
});

test("loaded_loras rows persist through refresh and preview renders", async ({ page }) => {
  await freshNodeWithText(page, "");
  // Feed the node a run-shaped payload containing a loaded_loras row — the
  // payload shape is pinned by the python tests; this exercises the frontend
  // storage + merge path the bug lived in.
  await page.evaluate(() => {
    const win = window as object as PreviewWindow;
    const node = win.__previewNode as (NodeLike & { onExecuted?(m: object): void }) | undefined;
    node?.onExecuted?.({
      civitai_resources_status: [
        JSON.stringify([
          { kind: "lora", status: "resolved", name: "fisheye_slider_v10", hash: "D6A3AC6F8A" },
        ]),
      ],
      civitai_resources_input: [""],
    });
  });
  await expect(page.locator(".clth-row").first()).toContainText("fisheye_slider_v10");

  // Refresh with an empty textbox: the lora row must survive.
  await clickRefresh(page);
  await expect(page.locator(".clth-row").first()).toContainText("fisheye_slider_v10");

  // Add a textbox line and refresh: both rows render, lora first.
  await page.evaluate((line) => {
    const win = window as object as PreviewWindow;
    const widget = win.__previewNode?.widgets?.find((w) => w.name === "civitai_resources");
    if (widget !== undefined) {
      widget.value = line;
      widget.callback?.();
    }
  }, PINNED_LINE);
  await clickRefresh(page);
  await expect(page.locator(".clth-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator(".clth-row").nth(0)).toContainText("fisheye_slider_v10");
  await expect(page.locator(".clth-row").nth(1)).toContainText("Anima Detailer");
});

test("refresh pulls loaded_loras from a linked LM loader before any run", async ({ page }) => {
  await freshNodeWithText(page, "");
  const linked = await page.evaluate(() => {
    const win = window as object as PreviewWindow;
    const node = win.__previewNode;
    const graph = win.app?.graph;
    if (node === undefined || graph === undefined) return "no node/graph";
    const loader = win.LiteGraph.createNode("Lora Loader (LoraManager)");
    if (loader === null) return "no LM loader node";
    graph.add(loader);
    // Mirror real LM state with one lora toggled OFF: the synced text widget
    // keeps the disabled tag, only the loras panel knows it's inactive.
    const text = loader.widgets?.find((w) => w.name === "text");
    if (text === undefined) return "no text widget";
    text.value = "<lora:fisheye_slider_v10:1> <lora:age_slider_v20:1>";
    const panel = loader.widgets?.find((w) => w.name === "loras");
    if (panel === undefined) return "no loras panel widget";
    // The live widget value is a plain array (the {__value__} wrapper only
    // exists in serialized prompts); its setter rejects anything else.
    panel.value = [
      { name: "fisheye_slider_v10", strength: 1, active: true },
      { name: "age_slider_v20", strength: 1, active: false },
    ];
    const outSlot = loader.outputs?.findIndex((o) => o.name === "loaded_loras") ?? -1;
    const inSlot = node.inputs?.findIndex((i) => i.name === "loaded_loras") ?? -1;
    if (outSlot < 0 || inSlot < 0) return `slots ${outSlot}/${inSlot}`;
    const link = loader.connect?.(outSlot, node, inSlot);
    return link === null || link === undefined ? "connect failed" : "ok";
  });
  expect(linked).toBe("ok");

  // No run has happened — refresh alone must surface the active lora row and
  // exclude the disabled one, matching what a run would load.
  await clickRefresh(page);
  await expect(page.locator(".clth-row").first()).toContainText(/fisheye/i, {
    timeout: 30_000,
  });
  await expect(page.locator(".clth-row")).toHaveCount(1);
  await expect(page.locator(".clth-row", { hasText: "age_slider" })).toHaveCount(0);
});

test("loading a saved workflow re-renders the status list", async ({ page }) => {
  await freshNodeWithText(page, PINNED_LINE);
  await clickRefresh(page);
  await expect(page.locator(".clth-row").first()).toBeVisible({ timeout: 30_000 });

  // Serialize the graph, hard-navigate to a blank slate, load the data back —
  // deterministic onConfigure without depending on the autosave debounce.
  const graph = await page.evaluate(() => {
    const win = window as object as PreviewWindow;
    return win.app?.graph?.serialize?.() ?? null;
  });
  expect(graph).not.toBeNull();
  await page.goto("/");
  await page.waitForFunction(() => {
    const win = window as object as PreviewWindow;
    return win.app?.loadGraphData !== undefined;
  });
  await page.evaluate(async (data) => {
    const win = window as object as PreviewWindow;
    await win.app?.loadGraphData?.(data);
  }, graph as object);
  await expect(page.locator(".clth-row").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".clth-row").first()).toContainText("Anima Detailer");
});
