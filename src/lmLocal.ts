// Soft-dependency client for ComfyUI-Lora-Manager (same-origin routes).
// LM's API is internal and unversioned — everything here degrades gracefully:
// lmAvailable() false hides the Local tab entirely.

export interface LocalLora {
  displayName: string;
  fileName: string;
  folder: string;
  sha256: string | null;
  previewUrl: string | null;
  modelId: number | null;
  versionId: number | null;
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
}

export async function lmAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/lm/health-check");
    return response.ok;
  } catch {
    return false;
  }
}

export async function searchLocalLoras(query: string, signal: AbortSignal): Promise<LocalLora[]> {
  const params = new URLSearchParams({ page_size: "50" });
  if (query.length > 0) {
    params.set("search", query);
    params.set("fuzzy", "true");
  }
  const response = await fetch(`/api/lm/loras/list?${params.toString()}`, { signal });
  if (!response.ok) {
    throw new Error(`lora manager list failed: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as RawLmList;
  const rows: LocalLora[] = [];
  for (const item of raw.items ?? []) {
    rows.push({
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
  return rows;
}
