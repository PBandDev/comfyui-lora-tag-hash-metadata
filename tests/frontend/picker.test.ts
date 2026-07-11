import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResourcePicker } from "../../src/picker";

const SEARCH_PAYLOAD = {
  items: [
    {
      id: 2767064,
      name: "Anima Detailer",
      type: "LORA",
      creator: { username: "Volnovik" },
      stats: { downloadCount: 249 },
      modelVersions: [
        {
          id: 3114726,
          name: "v0_8",
          baseModel: "Anima",
          images: [{ url: "https://image.civitai.com/x/u/original=true/9.jpeg" }],
        },
      ],
    },
    {
      id: 2458426,
      name: "Anima",
      type: "Checkpoint",
      creator: { username: "circlestone_labs" },
      stats: { downloadCount: 121046 },
      modelVersions: [{ id: 3108589, name: "turbo-v1.0", baseModel: "Anima", images: [] }],
    },
  ],
  metadata: { nextCursor: "cur|2" },
};

function stubFetch(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/lm/health-check")) return new Response("", { status: 404 });
    return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let text: string;
let close: (() => void) | undefined;

beforeEach(() => {
  text = "";
  close = undefined;
  stubFetch();
});

afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function open(): void {
  close =
    openResourcePicker({
      getText: () => text,
      setText: (value) => {
        text = value;
      },
    }) ?? undefined;
}

describe("openResourcePicker", () => {
  it("mounts one overlay, loads the browse feed, and injects styles once", async () => {
    open();
    await flush();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
    expect(document.querySelectorAll("#clth-picker-styles-v1")).toHaveLength(1);
    expect(document.querySelectorAll(".clth-pk-card")).toHaveLength(2);
    // second open is rejected while one is active
    const again = openResourcePicker({ getText: () => text, setText: () => undefined });
    expect(again).toBeNull();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
  });

  it("stages an add and applies it as a pinned line", async () => {
    open();
    await flush();
    const card = document.querySelectorAll<HTMLElement>(".clth-pk-card")[0];
    card.querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();
  });

  it("includes the weight suffix for lora-ish cards only", async () => {
    open();
    await flush();
    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    // LORA card has a weight input, Checkpoint card does not
    const weightInput = cards[0].querySelector<HTMLInputElement>(".clth-pk-weight");
    expect(weightInput).not.toBeNull();
    expect(cards[1].querySelector(".clth-pk-weight")).toBeNull();
    if (weightInput !== null) weightInput.value = "0.8";
    cards[0].querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726 0.8");
  });

  it("shows Remove for versions already in the textbox and applies the removal", async () => {
    text = "# keep me\nhttps://civitai.com/models/2767064?modelVersionId=3114726 0.8";
    open();
    await flush();
    const button = document.querySelectorAll<HTMLElement>(".clth-pk-card")[0]
      .querySelector<HTMLButtonElement>(".clth-pk-add");
    expect(button?.textContent).toBe("Remove");
    button?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("# keep me");
  });

  it("debounces typing before searching", async () => {
    vi.useFakeTimers();
    open();
    await vi.advanceTimersByTimeAsync(0);
    const spy = vi.mocked(fetch);
    const before = spy.mock.calls.length;
    const input = document.querySelector<HTMLInputElement>(".clth-pk-search");
    if (input === null) throw new Error("no search input");
    input.value = "anima";
    input.dispatchEvent(new Event("input"));
    expect(spy.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(350);
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(String(spy.mock.calls[spy.mock.calls.length - 1]?.[0])).toContain("query=anima");
  });

  it("closes on Escape and removes its capture listeners", async () => {
    open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();
  });

  it("hides the Local tab when LM health-check fails", async () => {
    open();
    await flush();
    expect(document.querySelector(".clth-pk-tab-local")).toBeNull();
  });

  it("shows the Local tab when LM answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/lm/health-check")) return new Response("{}", { status: 200 });
        if (url.includes("/api/lm/loras/list")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  model_name: "Anima Detailer",
                  file_name: "anima_detailer_v0_8",
                  folder: "Illustrious/anime",
                  sha256: "cd64af8696000000000000000000000000000000000000000000000000000000",
                  preview_url: null,
                  civitai: { id: 3114726, modelId: 2767064 },
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify(SEARCH_PAYLOAD), { status: 200 });
      }),
    );
    open();
    await flush();
    const tab = document.querySelector<HTMLButtonElement>(".clth-pk-tab-local");
    expect(tab).not.toBeNull();
    tab?.click();
    await flush();
    const row = document.querySelector<HTMLElement>(".clth-pk-card");
    expect(row?.textContent).toContain("Anima Detailer");
    row?.querySelector<HTMLButtonElement>(".clth-pk-add")?.click();
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
  });

  it("can reopen after an internal close and applies mixed add + removal", async () => {
    text = "https://civitai.com/models/2458426?modelVersionId=3108589";
    open();
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".clth-pk-overlay")).toBeNull();

    open(); // the singleton guard must have been released by the internal close
    await flush();
    const cards = document.querySelectorAll<HTMLElement>(".clth-pk-card");
    cards[0].querySelector<HTMLButtonElement>(".clth-pk-add")?.click(); // stage add (LORA)
    const removeButton = cards[1].querySelector<HTMLButtonElement>(".clth-pk-add");
    expect(removeButton?.textContent).toBe("Remove"); // checkpoint version already in node
    removeButton?.click(); // stage removal
    document.querySelector<HTMLButtonElement>(".clth-pk-apply")?.click();
    expect(text).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
  });

  it("closing immediately after open leaves no live listeners", async () => {
    open();
    close?.(); // before the deferred capture-listener attach fires
    await flush();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); // must not throw
    open(); // and a fresh picker still opens
    await flush();
    expect(document.querySelectorAll(".clth-pk-overlay")).toHaveLength(1);
  });
});
