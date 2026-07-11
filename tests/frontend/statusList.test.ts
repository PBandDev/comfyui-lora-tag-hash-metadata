import { describe, expect, it } from "vitest";
import { buildStatusList, parseStatusPayload, type ResourceEntry } from "../../src/statusList";

const entries: ResourceEntry[] = [
  {
    kind: "url",
    source: "https://civitai.com/models/2767064",
    status: "resolved",
    name: "Anima Detailer",
    type: "LORA",
    hash: "CD64AF8696",
    model_id: 2767064,
    version_id: 3114726,
    version_name: "v0_8",
    weight: null,
    unverified: false,
    error: null,
  },
  {
    kind: "url",
    source: "https://civitai.com/models/999999999",
    status: "missing",
    name: null,
    type: null,
    hash: null,
    model_id: null,
    version_id: null,
    version_name: null,
    weight: null,
    unverified: false,
    error: "not found: /api/v1/models/999999999",
  },
];

describe("buildStatusList", () => {
  it("renders resolved row with civitai link", () => {
    const el = buildStatusList(entries);
    const link = el.querySelector<HTMLAnchorElement>("a");
    expect(link?.href).toBe("https://civitai.com/models/2767064?modelVersionId=3114726");
    expect(el.textContent).toContain("Anima Detailer");
    expect(el.textContent).toContain("LORA");
    expect(el.textContent).toContain("v0_8");
  });

  it("renders failure row with reason", () => {
    const el = buildStatusList(entries);
    expect(el.textContent).toContain("not found");
    expect(el.querySelectorAll("[data-status='missing']").length).toBe(1);
  });

  it("renders duplicate row with marker", () => {
    const el = buildStatusList([
      { ...entries[0], status: "duplicate" },
    ]);
    expect(el.querySelectorAll("[data-status='duplicate']").length).toBe(1);
    expect(el.textContent).toContain("duplicate");
  });

  it("renders empty state", () => {
    expect(buildStatusList([]).textContent).toContain("No resources");
  });
});

describe("parseStatusPayload", () => {
  it("parses a valid payload", () => {
    const parsed = parseStatusPayload(JSON.stringify(entries));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].name).toBe("Anima Detailer");
  });

  it("returns empty on junk", () => {
    expect(parseStatusPayload("not json")).toEqual([]);
    expect(parseStatusPayload('{"a":1}')).toEqual([]);
    expect(parseStatusPayload('[{"nope":true}]')).toEqual([]);
  });

  it("keeps v1 lora entries missing optional fields", () => {
    const parsed = parseStatusPayload(
      '[{"kind":"lora","name":"foo","hash":"AB12CD34EF","weight":0.8,"status":"resolved"}]',
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe("lora");
  });
});
