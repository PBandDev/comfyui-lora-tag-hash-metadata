// Pure textbox-line helpers for the resource picker. Variant A: the multiline
// textbox is the single source of truth — the picker only appends and removes
// whole lines, and never reformats what the user typed.
// Regexes mirror civitai_resources_node.py (URL_RE / AIR_RE / HASH*_RE).

export interface PickedResource {
  modelId: number;
  versionId: number;
  weight: number | null;
}

export interface LineIdentities {
  versionIds: Set<number>;
  hashes: Set<string>; // AutoV2, uppercase
}

const CIVITAI_URL_RE = /^https?:\/\/(?:www\.)?civitai\.(?:com|red|green)\/models\/\d+/i;
const VERSION_PIN_RE = /[?&]modelVersionId=(\d+)/i;
const AIR_RE = /^urn:air:[a-z0-9]+:[a-z0-9]+:civitai:\d+@(\d+)/i;
const HASH10_RE = /^[0-9a-f]{10}$/i;
const HASH64_RE = /^[0-9a-f]{64}$/i;
const WEIGHT_SUFFIX_RE = /\s+[-+]?\d+(?:\.\d+)?$/;

function lineBody(raw: string): string | null {
  const line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) return null;
  return line.replace(WEIGHT_SUFFIX_RE, "").trim();
}

function versionIdOf(body: string): number | null {
  if (CIVITAI_URL_RE.test(body)) {
    const pin = body.match(VERSION_PIN_RE);
    return pin !== null ? Number(pin[1]) : null;
  }
  const air = body.match(AIR_RE);
  return air !== null ? Number(air[1]) : null;
}

function hashOf(body: string): string | null {
  if (HASH10_RE.test(body) || HASH64_RE.test(body)) {
    return body.slice(0, 10).toUpperCase();
  }
  return null;
}

export function identitiesIn(text: string): LineIdentities {
  const versionIds = new Set<number>();
  const hashes = new Set<string>();
  for (const raw of text.split("\n")) {
    const body = lineBody(raw);
    if (body === null) continue;
    const versionId = versionIdOf(body);
    if (versionId !== null) {
      versionIds.add(versionId);
      continue;
    }
    const hash = hashOf(body);
    if (hash !== null) hashes.add(hash);
  }
  return { versionIds, hashes };
}

export function lineFor(resource: PickedResource): string {
  const base = `https://civitai.com/models/${resource.modelId}?modelVersionId=${resource.versionId}`;
  return resource.weight === null ? base : `${base} ${resource.weight}`;
}

export function appendLines(text: string, lines: string[]): string {
  const trimmed = text.replace(/\s+$/, "");
  const block = lines.join("\n");
  return trimmed.length === 0 ? block : `${trimmed}\n${block}`;
}

function filterLines(text: string, keep: (body: string) => boolean): string {
  return text
    .split("\n")
    .filter((raw) => {
      const body = lineBody(raw);
      return body === null || keep(body);
    })
    .join("\n");
}

export function removeVersionLine(text: string, versionId: number): string {
  return filterLines(text, (body) => versionIdOf(body) !== versionId);
}

export function removeHashLine(text: string, autov2: string): string {
  const target = autov2.toUpperCase();
  return filterLines(text, (body) => hashOf(body) !== target);
}

// Status rows carry the raw line they came from — removing by raw text also
// works for lines the identity parsers reject (invalid/missing rows).
export function removeRawLine(text: string, raw: string): string {
  const target = raw.trim();
  if (target.length === 0) return text;
  let removed = false;
  return text
    .split("\n")
    .filter((line) => {
      if (removed || line.trim() !== target) return true;
      removed = true;
      return false;
    })
    .join("\n");
}
