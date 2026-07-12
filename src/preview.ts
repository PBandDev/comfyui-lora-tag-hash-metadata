// Client for the pack's own /clth/preview route: the python side runs the
// exact run-time parser+resolver+cache on the textbox text, minus
// loaded_loras (an execution-only input), and returns the same entries
// payload the node emits in its ui message.
import { type ResourceEntry, parseStatusPayload } from "./statusList";

export async function fetchPreview(
  text: string,
  loraHashes: string[],
  loadedLoras: string,
  signal: AbortSignal,
): Promise<ResourceEntry[]> {
  // "/api"-prefixed alias: works behind the Comfy frontend dev proxy and
  // API-only reverse proxies (same pattern as the /api/lm/* calls).
  // loaded_loras runs the full v1 lora path server-side; lora_hashes seeds
  // duplicate marking when only last-run hashes are known.
  const response = await fetch("/api/clth/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, lora_hashes: loraHashes, loaded_loras: loadedLoras }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`preview failed: HTTP ${response.status}`);
  }
  return parseStatusPayload(await response.text());
}
