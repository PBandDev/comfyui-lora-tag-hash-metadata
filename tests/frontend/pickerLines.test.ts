import { describe, expect, it } from "vitest";
import {
  appendLines,
  identitiesIn,
  lineFor,
  removeHashLine,
  removeRawLine,
  removeVersionLine,
} from "../../src/pickerLines";

const TEXT = [
  "# my resources",
  "https://civitai.com/models/2767064/anima-detailer?modelVersionId=3114726 0.8",
  "https://civitai.red/models/1362968/some-workflow",
  "urn:air:anima:lora:civitai:455382@3081605",
  "CD64AF8696",
  "0f3c77a1de55d2e90bc1b7a0299f44aa0f3c77a1de55d2e90bc1b7a0299f44aa 0.5",
].join("\n");

describe("identitiesIn", () => {
  it("collects pinned version ids from urls and airs, hashes as AutoV2", () => {
    const ids = identitiesIn(TEXT);
    expect(ids.versionIds).toEqual(new Set([3114726, 3081605]));
    expect(ids.hashes).toEqual(new Set(["CD64AF8696", "0F3C77A1DE"]));
  });

  it("ignores comments, blanks, unpinned urls, and junk", () => {
    const ids = identitiesIn("# c\n\nhttps://civitai.com/models/999\nnot a line\n");
    expect(ids.versionIds.size).toBe(0);
    expect(ids.hashes.size).toBe(0);
  });
});

describe("lineFor", () => {
  it("builds a pinned url line with optional weight", () => {
    expect(lineFor({ modelId: 1, versionId: 2, weight: null })).toBe(
      "https://civitai.com/models/1?modelVersionId=2",
    );
    expect(lineFor({ modelId: 1, versionId: 2, weight: 0.8 })).toBe(
      "https://civitai.com/models/1?modelVersionId=2 0.8",
    );
  });
});

describe("appendLines", () => {
  it("appends after trimming trailing whitespace", () => {
    expect(appendLines("a\n\n", ["b", "c"])).toBe("a\nb\nc");
  });

  it("handles an empty textbox", () => {
    expect(appendLines("", ["b"])).toBe("b");
    expect(appendLines("   \n", ["b"])).toBe("b");
  });
});

describe("removeVersionLine / removeHashLine", () => {
  it("removes only the matching line, preserving everything else verbatim", () => {
    const out = removeVersionLine(TEXT, 3114726);
    expect(out).not.toContain("modelVersionId=3114726");
    expect(out).toContain("# my resources");
    expect(out).toContain("https://civitai.red/models/1362968/some-workflow");
    expect(out.split("\n")).toHaveLength(TEXT.split("\n").length - 1);
  });

  it("removes air lines by version id", () => {
    const out = removeVersionLine(TEXT, 3081605);
    expect(out).not.toContain("urn:air:");
  });

  it("removes hash lines by AutoV2 regardless of case or length", () => {
    const out = removeHashLine(removeHashLine(TEXT, "CD64AF8696"), "0F3C77A1DE");
    expect(out).not.toContain("CD64AF8696");
    expect(out).not.toContain("0f3c77a1de");
  });

  it("leaves text untouched when nothing matches", () => {
    expect(removeVersionLine(TEXT, 42)).toBe(TEXT);
  });

  it("handles CRLF input", () => {
    const crlf = "CD64AF8696\r\nurn:air:anima:lora:civitai:1@77\r\n";
    const ids = identitiesIn(crlf);
    expect(ids.hashes.has("CD64AF8696")).toBe(true);
    expect(ids.versionIds.has(77)).toBe(true);
    expect(removeVersionLine(crlf, 77)).not.toContain("urn:air:");
  });
});

describe("removeRawLine", () => {
  it("removes the first line matching the raw text, preserving everything else", () => {
    const out = removeRawLine(TEXT, "CD64AF8696");
    expect(out).not.toContain("CD64AF8696");
    expect(out.split("\n")).toHaveLength(TEXT.split("\n").length - 1);
    expect(out).toContain("# my resources");
  });

  it("removes invalid/unparseable lines too (status rows for bad input)", () => {
    const text = "good line missing from parser\nCD64AF8696";
    expect(removeRawLine(text, "good line missing from parser")).toBe("CD64AF8696");
  });

  it("removes only the first occurrence of duplicated raw lines", () => {
    const text = "CD64AF8696\nCD64AF8696";
    expect(removeRawLine(text, "CD64AF8696")).toBe("CD64AF8696");
  });

  it("matches trimmed content and leaves non-matches verbatim", () => {
    const text = "  CD64AF8696  \r\nurn:air:anima:lora:civitai:1@77\r\n";
    const out = removeRawLine(text, "CD64AF8696");
    expect(out).not.toContain("CD64AF8696");
    expect(out).toContain("urn:air:anima:lora:civitai:1@77\r\n");
  });

  it("returns text unchanged when nothing matches", () => {
    expect(removeRawLine(TEXT, "not present")).toBe(TEXT);
  });
});
