import { expect, test } from "@playwright/test";

interface WidgetLike {
  name: string;
  value: string | number | boolean | object;
  callback?: (value?: string) => void;
}

interface NodeLike {
  widgets?: WidgetLike[];
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

test("refresh button previews the textbox without queueing a prompt", async ({ page }) => {
  await freshNodeWithText(page, `# comment\n${PINNED_LINE}`);
  await page.locator(".clth-refresh").click();

  const row = page.locator(".clth-row");
  await expect(row.first()).toBeVisible({ timeout: 30_000 });
  await expect(row.first()).toContainText("Anima Detailer");
  await expect(page.locator(".clth-note")).toContainText("preview");
});

test("row remove button deletes the line from the textbox", async ({ page }) => {
  await freshNodeWithText(page, PINNED_LINE);
  await page.locator(".clth-refresh").click();
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

test("loading a saved workflow re-renders the status list", async ({ page }) => {
  await freshNodeWithText(page, PINNED_LINE);
  await page.locator(".clth-refresh").click();
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
