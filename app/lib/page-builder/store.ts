import type { PBNode, PBState, PBProject } from "./types";
import {
  createRootNode,
  findNode,
  removeNode,
  insertNode,
  updateNode,
  moveNode,
  cloneNode,
} from "./utils";

const MAX_HISTORY = 50;

export function createStore(initialRoot?: PBNode) {
  const root = initialRoot ?? createRootNode();
  let state: PBState = {
    root,
    selection: { nodeId: null, hoverNodeId: null },
    history: [structuredClone(root)],
    historyIndex: 0,
    canvasScripts: [],
    canvasStyles: [],
  };
  const listeners = new Set<() => void>();

  function notify() {
    listeners.forEach((fn) => fn());
  }

  function pushHistory() {
    const h = state.history.slice(0, state.historyIndex + 1);
    h.push(structuredClone(state.root));
    if (h.length > MAX_HISTORY) h.shift();
    state = { ...state, history: h, historyIndex: h.length - 1 };
  }

  return {
    getState: () => state,
    getRoot: () => state.root,
    getSelectedNode: () =>
      state.selection.nodeId
        ? findNode(state.root, state.selection.nodeId)
        : null,

    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // Selection
    select: (nodeId: string | null) => {
      state = { ...state, selection: { ...state.selection, nodeId } };
      notify();
    },
    hover: (nodeId: string | null) => {
      state = { ...state, selection: { ...state.selection, hoverNodeId: nodeId } };
      notify();
    },

    // Mutations (all push to history)
    addNode: (parentId: string, node: PBNode, index?: number) => {
      state = { ...state, root: insertNode(state.root, parentId, node, index) };
      pushHistory();
      notify();
    },
    removeNode: (nodeId: string) => {
      if (state.selection.nodeId === nodeId) {
        state = { ...state, selection: { ...state.selection, nodeId: null } };
      }
      state = { ...state, root: removeNode(state.root, nodeId) };
      pushHistory();
      notify();
    },
    updateNode: (nodeId: string, updates: Partial<PBNode>) => {
      state = { ...state, root: updateNode(state.root, nodeId, updates) };
      pushHistory();
      notify();
    },
    moveNode: (nodeId: string, newParentId: string, index?: number) => {
      state = { ...state, root: moveNode(state.root, nodeId, newParentId, index) };
      pushHistory();
      notify();
    },
    duplicateNode: (nodeId: string) => {
      const node = findNode(state.root, nodeId);
      if (!node) return;
      const parent = findParentInTree(state.root, nodeId);
      if (!parent) return;
      const clone = cloneNode(node);
      state = {
        ...state,
        root: insertNode(state.root, parent.parent.id, clone, parent.index + 1),
      };
      pushHistory();
      notify();
    },

    // Undo/Redo
    undo: () => {
      if (state.historyIndex <= 0) return;
      state = {
        ...state,
        historyIndex: state.historyIndex - 1,
        root: structuredClone(state.history[state.historyIndex - 1]),
      };
      notify();
    },
    redo: () => {
      if (state.historyIndex >= state.history.length - 1) return;
      state = {
        ...state,
        historyIndex: state.historyIndex + 1,
        root: structuredClone(state.history[state.historyIndex + 1]),
      };
      notify();
    },

    // Canvas resources
    setCanvasScripts: (scripts: string[]) => {
      state = { ...state, canvasScripts: scripts };
      notify();
    },
    setCanvasStyles: (styles: string[]) => {
      state = { ...state, canvasStyles: styles };
      notify();
    },

    // Load/save
    loadProject: (project: PBProject) => {
      state = {
        ...state,
        root: project.root,
        canvasScripts: project.canvasScripts ?? [],
        canvasStyles: project.canvasStyles ?? [],
        history: [structuredClone(project.root)],
        historyIndex: 0,
        selection: { nodeId: null, hoverNodeId: null },
      };
      notify();
    },
    getProject: (): PBProject => ({
      version: 1,
      root: state.root,
      canvasScripts: state.canvasScripts,
      canvasStyles: state.canvasStyles,
    }),

    // Replace root entirely (for imports)
    setRoot: (root: PBNode) => {
      state = { ...state, root };
      pushHistory();
      notify();
    },
  };
}

function findParentInTree(
  root: PBNode,
  id: string
): { parent: PBNode; index: number } | null {
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i].id === id) {
      return { parent: root, index: i };
    }
    const found = findParentInTree(root.children[i], id);
    if (found) return found;
  }
  return null;
}

export type PBStore = ReturnType<typeof createStore>;
