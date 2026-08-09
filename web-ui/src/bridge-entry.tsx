import "./main.css";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { isSdkIconName, SDK_ICONS, type SdkIconName } from "./icons";

const roots = new WeakMap<Element, Root>();

function mountOne(el: Element): void {
  const name = el.getAttribute("data-sdk-icon");
  if (!name || !isSdkIconName(name)) return;
  const Icon = SDK_ICONS[name as SdkIconName];
  let root = roots.get(el);
  if (!root) {
    root = createRoot(el);
    roots.set(el, root);
  }
  const title = el.getAttribute("data-sdk-title") || undefined;
  root.render(
    createElement(Icon, {
      "aria-hidden": title ? undefined : true,
      role: title ? "img" : undefined,
      "aria-label": title,
      className: "sdk-icon",
    }),
  );
}

/** 扫描并挂载 `[data-sdk-icon="Archive"]` 等节点。可重复调用（列表重绘后）。 */
export function mountIcons(root: ParentNode = document): void {
  const nodes = root.querySelectorAll("[data-sdk-icon]");
  nodes.forEach((el) => mountOne(el));
}

declare global {
  interface Window {
    AppsSdkUI: {
      mountIcons: typeof mountIcons;
      iconNames: SdkIconName[];
    };
  }
}

window.AppsSdkUI = {
  mountIcons,
  iconNames: Object.keys(SDK_ICONS) as SdkIconName[],
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => mountIcons());
} else {
  mountIcons();
}
