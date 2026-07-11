import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";
import { SETTINGS_IDS } from "./constants";
import { buildStatusList, parseStatusPayload } from "./statusList";

declare global {
  const app: ComfyApp;

  interface Window {
    app: ComfyApp;
  }
}

const V2_NODE_ID = "CivitaiResourcesToHashMetadata";
const WIDGET_NAME = "civitai_status";
// The node reserves [min,max] px for the widget; content beyond the cap
// scrolls INSIDE the host so it can never overflow the node bounds.
const WIDGET_MIN_HEIGHT = 60;
const WIDGET_MAX_HEIGHT = 320;

interface StatusMessage {
  civitai_resources_status?: string[];
}

interface StatusNodeLike {
  size?: [number, number];
  widgets?: { name: string }[];
  addDOMWidget?(
    name: string,
    type: string,
    element: HTMLElement,
    options: {
      serialize: boolean;
      hideOnZoom: boolean;
      getMinHeight: () => number;
      getMaxHeight: () => number;
    },
  ): { serialize?: boolean } | undefined;
  computeSize?(): [number, number];
  setSize?(size: [number, number]): void;
  setDirtyCanvas?(foreground: boolean, background: boolean): void;
  onNodeCreated?(): void;
  onExecuted?(message: StatusMessage): void;
}

const statusHosts = new WeakMap<StatusNodeLike, HTMLDivElement>();

function createStatusHost(node: StatusNodeLike): HTMLDivElement | null {
  if (typeof node.addDOMWidget !== "function") {
    return null;
  }
  const host = document.createElement("div");
  host.className = "clth-host";
  host.dataset.widget = WIDGET_NAME;
  host.style.maxHeight = `${WIDGET_MAX_HEIGHT}px`;
  const widget = node.addDOMWidget(WIDGET_NAME, "div", host, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () =>
      Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, host.scrollHeight)),
    getMaxHeight: () => WIDGET_MAX_HEIGHT,
  });
  if (widget !== undefined) {
    widget.serialize = false;
  }
  host.replaceChildren(buildStatusList([]));
  statusHosts.set(node, host);
  return host;
}

function statusHostFor(node: StatusNodeLike): HTMLDivElement | null {
  const host = statusHosts.get(node);
  if (host !== undefined && node.widgets?.some((widget) => widget.name === WIDGET_NAME)) {
    return host;
  }
  return createStatusHost(node);
}

function syncNodeSize(node: StatusNodeLike): void {
  // Canvas mode auto-grows but never shrinks, and scrollHeight is only valid
  // after layout — recompute on the next frame.
  requestAnimationFrame(() => {
    if (typeof node.computeSize === "function" && typeof node.setSize === "function") {
      const computed = node.computeSize();
      const width = Math.max(node.size?.[0] ?? computed[0], computed[0]);
      node.setSize([width, computed[1]]);
    }
    node.setDirtyCanvas?.(true, true);
  });
}

app.registerExtension({
  name: "ComfyUI LoRA Tag Hash Metadata",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== V2_NODE_ID) {
      return;
    }
    const proto = nodeType.prototype as StatusNodeLike;
    const originalCreated = proto.onNodeCreated;
    proto.onNodeCreated = function (this: StatusNodeLike) {
      originalCreated?.call(this);
      createStatusHost(this);
      syncNodeSize(this);
    };
    const originalExecuted = proto.onExecuted;
    proto.onExecuted = function (this: StatusNodeLike, message: StatusMessage) {
      originalExecuted?.call(this, message);
      const payload = message.civitai_resources_status?.[0] ?? "[]";
      const host = statusHostFor(this);
      if (host === null) {
        return;
      }
      host.replaceChildren(
        buildStatusList(parseStatusPayload(payload), {
          onImageLoad: () => this.setDirtyCanvas?.(true, true),
        }),
      );
      syncNodeSize(this);
    };
  },
  settings: [
    {
      id: SETTINGS_IDS.VERSION,
      name: "Version 1.1.0",
      type: () => {
        const spanEl = document.createElement("span");
        spanEl.insertAdjacentHTML(
          "beforeend",
          `<a href="https://github.com/PBandDev/comfyui-lora-tag-hash-metadata" target="_blank" style="padding-right: 12px;">Homepage</a>`
        );

        return spanEl;
      },
      defaultValue: undefined,
    },
    {
      id: SETTINGS_IDS.DEBUG_LOGGING,
      name: "Enable Debug Logging",
      type: "boolean",
      tooltip:
        "Show detailed debug logs in browser console during operation",
      defaultValue: false,
    },
  ]
});
