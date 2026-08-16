import { expect, test } from "@playwright/test";

interface WidgetLike {
  name: string;
  value: string | number | boolean | object;
}

interface GraphNodeLike {
  widgets?: WidgetLike[];
  size?: [number, number];
  setSize?(size: [number, number]): void;
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
  // The resolved entry carries a civitai preview thumbnail.
  await expect(list.locator("[data-status='resolved'] img")).toHaveCount(1);

  // The widget must stay inside the node: the host is the scroll container.
  const bounded = await page.evaluate(() => {
    const host = document.querySelector<HTMLDivElement>(".clth-host");
    if (host === null) return false;
    return host.scrollHeight >= host.clientHeight;
  });
  expect(bounded).toBe(true);
});

test("node resize flexes the status list only; textarea stays pinned", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => window.app?.graph !== undefined);

  const created = await page.evaluate(() => {
    window.app.graph?.clear();
    const node = window.LiteGraph.createNode("CivitaiResourcesToHashMetadata");
    if (node === null) return false;
    window.app.graph?.add(node);
    return true;
  });
  expect(created).toBe(true);
  await expect(page.locator(".clth-host")).toBeVisible();

  const measure = () =>
    page.evaluate(() => {
      const host = document.querySelector<HTMLDivElement>(".clth-host");
      const textarea = document.querySelector<HTMLTextAreaElement>(".comfy-multiline-input");
      return {
        host: host?.clientHeight ?? -1,
        textarea: textarea?.clientHeight ?? -1,
      };
    });

  const before = await measure();
  expect(before.host).toBeGreaterThan(0);
  expect(before.textarea).toBeGreaterThan(0);

  const resized = await page.evaluate(() => {
    const graph = window.app.graph as unknown as { nodes?: GraphNodeLike[] } | undefined;
    const target = graph?.nodes?.[0];
    if (target?.size === undefined || typeof target.setSize !== "function") return false;
    target.setSize([target.size[0], target.size[1] + 150]);
    return true;
  });
  expect(resized).toBe(true);

  // All extra height goes to the status list; the textbox strip must not move.
  await expect
    .poll(async () => (await measure()).host, { timeout: 5_000 })
    .toBeGreaterThanOrEqual(before.host + 140);
  expect((await measure()).textarea).toBe(before.textarea);
});
