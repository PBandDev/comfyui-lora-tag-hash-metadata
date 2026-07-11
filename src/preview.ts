// Client for the pack's own /clth/preview route: the python side runs the
// exact run-time parser+resolver+cache on the textbox text, minus
// loaded_loras (an execution-only input), and returns the same entries
// payload the node emits in its ui message.
import { type ResourceEntry, parseStatusPayload } from "./statusList";

export async function fetchPreview(text: string, signal: AbortSignal): Promise<ResourceEntry[]> {
  const response = await fetch("/clth/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`preview failed: HTTP ${response.status}`);
  }
  return parseStatusPayload(await response.text());
}
