import { expect, test } from "@playwright/test";
import { SETTINGS_IDS } from "../../src/constants";

const EXAMPLE_NODE_ID = "LoraTagsToHashMetadata";

test("custom node pack loads in ComfyUI", async ({ page, request }) => {
  await page.goto("/");

  await page.waitForFunction((debugLoggingSettingId) => {
    const comfyWindow = window as {
      app?: {
        extensionManager?: {
          setting?: {
            get: (id: string) => boolean | undefined;
          };
        };
      };
    };

    return comfyWindow.app?.extensionManager?.setting?.get(debugLoggingSettingId) === false;
  }, SETTINGS_IDS.DEBUG_LOGGING);

  const objectInfoResponse = await request.get("/api/object_info");
  expect(objectInfoResponse.ok()).toBe(true);

  const objectInfo = (await objectInfoResponse.json()) as Record<string, object>;
  expect(objectInfo[EXAMPLE_NODE_ID]).toBeDefined();
});
