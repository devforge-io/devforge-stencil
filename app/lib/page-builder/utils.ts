import type { PBNode } from "./types";

let _counter = 0;
export function generateId(): string {
  return `pb-${Date.now().toString(36)}-${(++_counter).toString(36)}`;
}

export function createNode(
  tag: string,
  overrides: Partial<PBNode> = {}
): PBNode {
  const isVoid = ["img", "hr", "br", "input"].includes(tag);
  return {
    id: generateId(),
    tag,
    type: isVoid ? "void" : "element",
    classes: [],
    styles: {},
    attributes: {},
    children: [],
    editable: !isVoid,
    droppable: !isVoid,
    draggable: true,
    ...overrides,
  };
}

export function createTextNode(text: string): PBNode {
  return {
    id: generateId(),
    tag: "span",
    type: "text",
    classes: [],
    styles: {},
    attributes: {},
    children: [],
    text,
    editable: true,
    droppable: false,
    draggable: true,
  };
}

export function createRootNode(): PBNode {
  return createNode("div", {
    id: "pb-root",
    name: "Body",
    draggable: false,
    classes: ["min-h-screen"],
  });
}

export function findNode(root: PBNode, id: string): PBNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function findParent(
  root: PBNode,
  id: string
): { parent: PBNode; index: number } | null {
  for (let i = 0; i < root.children.length; i++) {
    if (root.children[i].id === id) {
      return { parent: root, index: i };
    }
    const found = findParent(root.children[i], id);
    if (found) return found;
  }
  return null;
}

export function cloneNode(node: PBNode): PBNode {
  return {
    ...node,
    id: generateId(),
    children: node.children.map(cloneNode),
  };
}

export function removeNode(root: PBNode, id: string): PBNode {
  return {
    ...root,
    children: root.children
      .filter((c) => c.id !== id)
      .map((c) => removeNode(c, id)),
  };
}

export function insertNode(
  root: PBNode,
  parentId: string,
  node: PBNode,
  index?: number
): PBNode {
  if (root.id === parentId) {
    const children = [...root.children];
    if (index !== undefined && index >= 0) {
      children.splice(index, 0, node);
    } else {
      children.push(node);
    }
    return { ...root, children };
  }
  return {
    ...root,
    children: root.children.map((c) => insertNode(c, parentId, node, index)),
  };
}

export function updateNode(
  root: PBNode,
  id: string,
  updates: Partial<PBNode>
): PBNode {
  if (root.id === id) {
    return { ...root, ...updates };
  }
  return {
    ...root,
    children: root.children.map((c) => updateNode(c, id, updates)),
  };
}

export function moveNode(
  root: PBNode,
  nodeId: string,
  newParentId: string,
  index?: number
): PBNode {
  const node = findNode(root, nodeId);
  if (!node) return root;
  const withoutNode = removeNode(root, nodeId);
  return insertNode(withoutNode, newParentId, node, index);
}
