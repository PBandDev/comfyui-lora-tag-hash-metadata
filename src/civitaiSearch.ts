// Browser-side civitai search client for the resource picker.
// Direct fetch is safe: /api/v1/models answers with
// Access-Control-Allow-Origin: * for header-less GETs. Never attach headers —
// any custom header forces a CORS preflight, which civitai rejects (405).

export const SEARCH_SORTS = ["Most Downloaded", "Newest", "Highest Rated"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const SEARCH_TYPES = ["LORA", "Checkpoint", "Workflows", "TextEncoder", "Other"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

// Weights only make sense for strength-applied types; anything else would emit
// 3-part entries Image Saver drops when download_civitai_data is off.
const WEIGHTED_TYPES: ReadonlySet<string> = new Set([
  "LORA",
  "LoCon",
  "DoRA",
  "TextualInversion",
]);

export function typeAcceptsWeight(type: string): boolean {
  return WEIGHTED_TYPES.has(type);
}

export interface SearchQuery {
  query?: string;
  type?: SearchType;
  sort?: SearchSort;
  cursor?: string;
  limit?: number;
}

export interface VersionCard {
  id: number;
  name: string;
  baseModel: string;
}

export interface ModelCard {
  id: number;
  name: string;
  type: string;
  creator: string;
  downloads: number;
  thumbnail: string | null;
  versions: VersionCard[];
}

export interface SearchPage {
  items: ModelCard[];
  nextCursor: string | null;
}

const API_BASE = "https://civitai.com/api/v1/models";
const THUMB_TRANSFORM_RE = /\/(?:original=true|width=\d+)[^/]*\//;
const THUMB_TRANSFORM = "/width=96,anim=false/";

export function thumbnailUrl(url: string): string {
  return url.replace(THUMB_TRANSFORM_RE, THUMB_TRANSFORM);
}

export function buildSearchUrl(q: SearchQuery): string {
  const params = new URLSearchParams();
  if (q.query !== undefined && q.query.length > 0) params.set("query", q.query);
  if (q.type !== undefined) params.append("types", q.type);
  if (q.sort !== undefined) params.set("sort", q.sort);
  if (q.cursor !== undefined) params.set("cursor", q.cursor);
  params.set("limit", String(q.limit ?? 20));
  // The API defaults to SFW-only; this node never gates content.
  params.set("nsfw", "true");
  return `${API_BASE}?${params.toString()}`;
}

interface RawImage {
  url?: string;
}
interface RawVersion {
  id?: number;
  name?: string;
  baseModel?: string;
  images?: RawImage[];
}
interface RawModel {
  id?: number;
  name?: string;
  type?: string;
  creator?: { username?: string } | null;
  stats?: { downloadCount?: number };
  modelVersions?: RawVersion[];
}
interface RawPage {
  items?: RawModel[];
  metadata?: { nextCursor?: string };
}

function mapModel(raw: RawModel): ModelCard | null {
  if (typeof raw.id !== "number" || typeof raw.name !== "string") return null;
  const versions: VersionCard[] = [];
  for (const v of raw.modelVersions ?? []) {
    if (typeof v.id !== "number") continue;
    versions.push({
      id: v.id,
      name: typeof v.name === "string" ? v.name : String(v.id),
      baseModel: typeof v.baseModel === "string" ? v.baseModel : "",
    });
  }
  if (versions.length === 0) return null;
  const firstImage = raw.modelVersions?.[0]?.images?.find(
    (image): image is { url: string } => typeof image.url === "string",
  );
  return {
    id: raw.id,
    name: raw.name,
    type: typeof raw.type === "string" ? raw.type : "Other",
    creator: raw.creator?.username ?? "",
    downloads: raw.stats?.downloadCount ?? 0,
    thumbnail: firstImage !== undefined ? thumbnailUrl(firstImage.url) : null,
    versions,
  };
}

function backoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort);
  });
}

export async function searchModels(q: SearchQuery, signal: AbortSignal): Promise<SearchPage> {
  const url = buildSearchUrl(q);
  let response = await fetch(url, { signal });
  if (response.status >= 500) {
    // civitai intermittently answers 5xx; one short retry rides out most
    // flaps (the python resolver retries the same way).
    await backoff(750, signal);
    response = await fetch(url, { signal });
  }
  if (!response.ok) {
    throw new Error(`civitai search failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as RawPage;
  const items: ModelCard[] = [];
  for (const model of raw.items ?? []) {
    const mapped = mapModel(model);
    if (mapped !== null) items.push(mapped);
  }
  return { items, nextCursor: raw.metadata?.nextCursor ?? null };
}
