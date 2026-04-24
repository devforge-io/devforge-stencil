// Stencil Page Builder
// A lightweight, Tailwind-first visual page builder

export { createStore } from "./store";
export type { PBStore } from "./store";

export { Canvas } from "./canvas";
export { Layers } from "./layers";
export { BlockPanel } from "./block-panel";
export { PropertiesPanel } from "./properties-panel";

export { renderToHtml, parseHtml } from "./serializer";

export { DEFAULT_BLOCKS } from "./blocks";

export {
  createNode,
  createTextNode,
  createRootNode,
  findNode,
  findParent,
  cloneNode,
  removeNode,
  insertNode,
  updateNode,
  moveNode,
  generateId,
} from "./utils";

export type {
  PBNode,
  PBBlock,
  PBSelection,
  PBState,
  PBProject,
} from "./types";
