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

interface StatusMessage {
  civitai_resources_status?: string[];
}

interface StatusNodeLike {
  widgets?: { name: string }[];
  addDOMWidget?(
    name: string,
    type: string,
    element: HTMLElement,
    options: { serialize: boolean; hideOnZoom: boolean },
  ): void;
  onExecuted?(message: StatusMessage): void;
}

const statusHosts = new WeakMap<StatusNodeLike, HTMLDivElement>();

function statusHostFor(node: StatusNodeLike): HTMLDivElement | null {
  let host = statusHosts.get(node);
  if (host === undefined || !node.widgets?.some((widget) => widget.name === WIDGET_NAME)) {
    if (typeof node.addDOMWidget !== "function") {
      return null;
    }
    host = document.createElement("div");
    host.dataset.widget = WIDGET_NAME;
    node.addDOMWidget(WIDGET_NAME, "div", host, { serialize: false, hideOnZoom: false });
    statusHosts.set(node, host);
  }
  return host;
}

app.registerExtension({
  name: "ComfyUI LoRA Tag Hash Metadata",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== V2_NODE_ID) {
      return;
    }
    const proto = nodeType.prototype as StatusNodeLike;
    const original = proto.onExecuted;
    proto.onExecuted = function (this: StatusNodeLike, message: StatusMessage) {
      original?.call(this, message);
      const payload = message.civitai_resources_status?.[0] ?? "[]";
      const host = statusHostFor(this);
      host?.replaceChildren(buildStatusList(parseStatusPayload(payload)));
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
