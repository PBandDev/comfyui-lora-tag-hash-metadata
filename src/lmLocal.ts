// Soft-dependency client for ComfyUI-Lora-Manager (same-origin routes).
// LM's API is internal and unversioned — everything here degrades gracefully:
// lmAvailable() false hides the Local tab entirely, and a kind whose route is
// missing (older LM) just drops out of the merged results.

// The three model types LM registers in its ModelServiceFactory — each gets
// the same /api/lm/<kind>/list route from the shared route registrar.
export const LOCAL_KINDS = ["loras", "checkpoints", "embeddings"] as const;
export type LocalKind = (typeof LOCAL_KINDS)[number];

export interface LocalModel {
  kind: LocalKind;
  displayName: string;
  fileName: string;
  folder: string;
  sha256: string | null;
  previewUrl: string | null;
  modelId: number | null;
  versionId: number | null;
}

export interface LocalSearchResult {
  rows: LocalModel[];
  // Kinds whose list call failed while at least one other succeeded — the
  // caller surfaces these instead of silently showing a partial catalog.
  failedKinds: LocalKind[];
  // Kinds where LM reported more items than one page returned — the caller
  // surfaces the cap instead of presenting a truncated list as complete.
  truncatedKinds: LocalKind[];
}

interface RawLmCivitai {
  id?: number;
  modelId?: number;
}
interface RawLmItem {
  model_name?: string;
  file_name?: string;
  folder?: string;
  sha256?: string | null;
  preview_url?: string | null;
  civitai?: RawLmCivitai | null;
}
interface RawLmList {
  items?: RawLmItem[];
  total?: number;
}

export async function lmAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/lm/health-check");
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchKind(
  kind: LocalKind,
  query: string,
  signal: AbortSignal,
): Promise<{ rows: LocalModel[]; total: number | null }> {
  // LM clamps page_size to 100 server-side (model_handlers). One page plus
  // the reported total: bigger collections narrow via the server-side fuzzy
  // search, and the caller flags the kind as truncated instead of paginating.
  const params = new URLSearchParams({ page_size: "100" });
  if (query.length > 0) {
    params.set("search", query);
    // LM renamed the flag from `fuzzy` to `fuzzy_search`; send both so either
    // vintage fuzzy-matches.
    params.set("fuzzy", "true");
    params.set("fuzzy_search", "true");
  }
  const response = await fetch(`/api/lm/${kind}/list?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`lora manager ${kind} list failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as RawLmList;
  const rows: LocalModel[] = [];
  for (const item of raw.items ?? []) {
    rows.push({
      kind,
      displayName: item.model_name ?? item.file_name ?? "(unnamed)",
      fileName: item.file_name ?? "",
      folder: item.folder ?? "",
      sha256: typeof item.sha256 === "string" && item.sha256.length > 0 ? item.sha256 : null,
      previewUrl:
        typeof item.preview_url === "string" && item.preview_url.length > 0
          ? item.preview_url
          : null,
      modelId: item.civitai?.modelId ?? null,
      versionId: item.civitai?.id ?? null,
    });
  }
  return { rows, total: typeof raw.total === "number" ? raw.total : null };
}

export async function searchLocalModels(
  kinds: readonly LocalKind[],
  query: string,
  signal: AbortSignal,
): Promise<LocalSearchResult> {
  const settled = await Promise.allSettled(kinds.map((kind) => fetchKind(kind, query, signal)));
  const rows: LocalModel[] = [];
  const failedKinds: LocalKind[] = [];
  const truncatedKinds: LocalKind[] = [];
  let firstError: unknown = null;
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      rows.push(...result.value.rows);
      const total = result.value.total;
      if (total !== null && total > result.value.rows.length) truncatedKinds.push(kinds[index]);
      return;
    }
    failedKinds.push(kinds[index]);
    if (firstError === null) firstError = result.reason;
  });
  // All requested kinds failing is a real error (LM down, aborted); one kind
  // failing among several is a degraded-but-usable catalog.
  if (kinds.length > 0 && failedKinds.length === kinds.length) {
    throw firstError instanceof Error ? firstError : new Error("lora manager list failed");
  }
  return { rows, failedKinds, truncatedKinds };
}
