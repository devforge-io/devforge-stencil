export interface PBNode {
  id: string;
  tag: string;
  type: "element" | "text" | "void";
  name?: string;
  classes: string[];
  styles: Record<string, string>;
  attributes: Record<string, string>;
  children: PBNode[];
  text?: string; // for text nodes
  editable?: boolean;
  droppable?: boolean;
  draggable?: boolean;
}

export interface PBBlock {
  id: string;
  label: string;
  category: string;
  icon?: string; // SVG string
  content: string; // HTML string
}

export interface PBSelection {
  nodeId: string | null;
  hoverNodeId: string | null;
}

export interface PBState {
  root: PBNode;
  selection: PBSelection;
  history: PBNode[];
  historyIndex: number;
  canvasScripts: string[];
  canvasStyles: string[];
}

export interface PBProject {
  version: number;
  root: PBNode;
  canvasScripts: string[];
  canvasStyles: string[];
  meta?: Record<string, unknown>;
}
