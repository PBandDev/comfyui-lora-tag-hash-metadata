import { expect, test } from "@playwright/test";

interface WidgetLike {
  name: string;
  value: string | number | boolean | object;
}

interface GraphNodeLike {
  widgets?: WidgetLike[];
}

interface GraphLike {
  add(node: GraphNodeLike): void;
  clear(): void;
}

interface AppLike {
  graph?: GraphLike;
  queuePrompt(number: number): Promise<void>;
}

interface LiteGraphLike {
  createNode(type: string): GraphNodeLike | null;
}

declare global {
  interface Window {
    app: AppLike;
    LiteGraph: LiteGraphLike;
  }
}

test("status list renders success and failure rows", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.app?.graph !== undefined);

  const created = await page.evaluate(() => {
    window.app.graph?.clear();
    const node = window.LiteGraph.createNode("CivitaiResourcesToHashMetadata");
    if (node === null) return false;
    window.app.graph?.add(node);
    const widget = node.widgets?.find((w) => w.name === "civitai_resources");
    if (!widget) return false;
    widget.value =
      "https://civitai.com/models/2767064?modelVersionId=3114726\nhttps://civitai.com/models/999999999";
    return true;
  });
  expect(created).toBe(true);

  await page.evaluate(async () => {
    await window.app.queuePrompt(0);
  });

  const list = page.locator(".civitai-status-list");
  await expect(list).toBeVisible({ timeout: 60_000 });
  await expect(list.locator("[data-status='resolved']")).toHaveCount(1);
  await expect(list.locator("[data-status='missing']")).toHaveCount(1);
  await expect(list.locator("a")).toHaveAttribute(
    "href",
    "https://civitai.com/models/2767064?modelVersionId=3114726",
  );
});
