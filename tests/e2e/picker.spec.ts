import { expect, test } from "@playwright/test";

// No `declare global` here: tsconfig excludes tests/e2e from typecheck, and
// other specs already augment Window with their own shapes — local casts keep
// this file self-contained either way.
interface WidgetLike {
  name: string;
  value: string | number | boolean | object;
  callback?: () => void;
}

interface NodeLike {
  widgets?: WidgetLike[];
}

interface PickerWindow {
  app?: { graph?: { add(node: NodeLike): void; clear(): void } };
  LiteGraph: { createNode(type: string): NodeLike | null };
  __pickerNode?: NodeLike;
}

async function openPickerOnFreshNode(
  page: import("@playwright/test").Page,
  initialText = "",
): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => {
    const win = window as object as PickerWindow;
    return win.app?.graph !== undefined;
  });
  const opened = await page.evaluate((text) => {
    const win = window as object as PickerWindow;
    win.app?.graph?.clear();
    const node = win.LiteGraph.createNode("CivitaiResourcesToHashMetadata");
    if (node === null) return false;
    win.app?.graph?.add(node);
    win.__pickerNode = node;
    const widget = node.widgets?.find((w) => w.name === "civitai_resources");
    if (widget !== undefined && text.length > 0) widget.value = text;
    const button = node.widgets?.find((w) => w.name === "＋ Add Resource");
    if (button?.callback === undefined) return false;
    button.callback();
    return true;
  }, initialText);
  expect(opened).toBe(true);
  await expect(page.locator(".clth-pk-overlay")).toBeVisible();
}

function textboxValue(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const win = window as object as PickerWindow;
    const widget = win.__pickerNode?.widgets?.find((w) => w.name === "civitai_resources");
    return String(widget?.value ?? "");
  });
}

test("browse feed renders, live search stages an add, apply pins the line", async ({ page }) => {
  await openPickerOnFreshNode(page);

  // Browse feed (no query) must populate from the live API.
  await expect(page.locator(".clth-pk-card").first()).toBeVisible({ timeout: 30_000 });

  // Old browse cards linger until the debounced search lands — wait for the
  // actual query response so the locator can't match stale content.
  const searchResponse = page.waitForResponse(
    (response) => response.url().includes("query=anima"),
    { timeout: 30_000 },
  );
  await page.fill(".clth-pk-search", "anima detailer");
  await searchResponse;
  await expect(
    page.locator(".clth-pk-card", { hasText: "Anima Detailer" }).first(),
  ).toBeVisible({ timeout: 30_000 });

  const card = page.locator(".clth-pk-card", { hasText: "Anima Detailer" }).first();
  await card.locator(".clth-pk-add").click();
  await expect(page.locator(".clth-pk-count")).toHaveText("1 staged");
  await page.locator(".clth-pk-apply").click();

  await expect(page.locator(".clth-pk-overlay")).toHaveCount(0);
  const value = await textboxValue(page);
  expect(value).toMatch(/^https:\/\/civitai\.com\/models\/\d+\?modelVersionId=\d+$/m);
});

test("a just-added version shows Remove on reopen and apply deletes it", async ({ page }) => {
  // Add via the picker first so the pinned version id comes from the live API
  // itself — no hardcoded version that could drift when the creator publishes.
  await openPickerOnFreshNode(page);
  const firstSearch = page.waitForResponse((r) => r.url().includes("query=anima"), {
    timeout: 30_000,
  });
  await page.fill(".clth-pk-search", "anima detailer");
  await firstSearch;
  const card = page.locator(".clth-pk-card", { hasText: "Anima Detailer" }).first();
  await card.locator(".clth-pk-add").click();
  await page.locator(".clth-pk-apply").click();
  await expect(page.locator(".clth-pk-overlay")).toHaveCount(0);
  expect(await textboxValue(page)).toMatch(/modelVersionId=\d+/);

  // Reopen on the same node: the same card must now offer Remove.
  await page.evaluate(() => {
    const win = window as object as PickerWindow;
    win.__pickerNode?.widgets?.find((w) => w.name === "＋ Add Resource")?.callback?.();
  });
  const secondSearch = page.waitForResponse((r) => r.url().includes("query=anima"), {
    timeout: 30_000,
  });
  await page.fill(".clth-pk-search", "anima detailer");
  await secondSearch;
  const button = page
    .locator(".clth-pk-card", { hasText: "Anima Detailer" })
    .first()
    .locator(".clth-pk-add");
  await expect(button).toHaveText("Remove", { timeout: 30_000 });
  await button.click();
  await page.locator(".clth-pk-apply").click();
  expect(await textboxValue(page)).toBe("");
});

test("local tab lists LM loras and inserts a line", async ({ page }) => {
  await openPickerOnFreshNode(page);

  const localTab = page.locator(".clth-pk-tab-local");
  await expect(localTab).toBeVisible({ timeout: 15_000 });
  await localTab.click();
  await expect(page.locator(".clth-pk-card").first()).toBeVisible({ timeout: 30_000 });

  await page.locator(".clth-pk-card .clth-pk-add:not([disabled])").first().click();
  await page.locator(".clth-pk-apply").click();
  const value = await textboxValue(page);
  // Matched loras insert a pinned url; unmatched insert an AutoV2 hash.
  expect(value).toMatch(/(modelVersionId=\d+|^[0-9A-F]{10}(\s|$))/m);
});
