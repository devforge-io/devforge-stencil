import { useState, useCallback, useEffect } from "react";
import type { PBNode } from "./types";
import type { PBStore } from "./store";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { twMerge } from "tailwind-merge";

interface PropertiesPanelProps {
  store: PBStore;
  node: PBNode;
}

export function PropertiesPanel({ store, node }: PropertiesPanelProps) {
  return (
    <div className="space-y-3">
      {/* Node info */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Element</Label>
        <p className="text-sm font-medium">{node.name ?? node.tag}</p>
        <code className="text-[10px] text-muted-foreground">&lt;{node.tag}&gt;</code>
      </div>

      <Separator />

      {/* Text content */}
      {(node.type === "text" || (!node.children.length && node.editable)) && (
        <>
          <TextEditor store={store} node={node} />
          <Separator />
        </>
      )}

      {/* Attributes */}
      <AttributeEditor store={store} node={node} />

      <Separator />

      {/* Classes */}
      <ClassEditor store={store} node={node} />

      <Separator />

      {/* Inline styles */}
      <StyleEditor store={store} node={node} />
    </div>
  );
}

function TextEditor({ store, node }: { store: PBStore; node: PBNode }) {
  const [value, setValue] = useState(node.text ?? "");

  // Sync when a different node is selected
  useEffect(() => {
    setValue(node.text ?? "");
  }, [node.id, node.text]);

  const handleBlur = useCallback(() => {
    store.updateNode(node.id, { text: value });
  }, [store, node.id, value]);

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Text</Label>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => e.key === "Enter" && handleBlur()}
        className="h-7 text-xs"
      />
    </div>
  );
}

function AttributeEditor({ store, node }: { store: PBStore; node: PBNode }) {
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const commonAttrs = node.tag === "a" ? ["href", "target", "title"] :
    node.tag === "img" ? ["src", "alt", "width", "height"] :
    node.tag === "input" ? ["type", "name", "placeholder", "value"] :
    [];

  const handleSet = useCallback(
    (key: string, value: string) => {
      store.updateNode(node.id, {
        attributes: { ...node.attributes, [key]: value },
      });
    },
    [store, node.id, node.attributes]
  );

  const handleRemove = useCallback(
    (key: string) => {
      const { [key]: _, ...rest } = node.attributes;
      store.updateNode(node.id, { attributes: rest });
    },
    [store, node.id, node.attributes]
  );

  const handleAdd = useCallback(() => {
    if (!newKey.trim()) return;
    handleSet(newKey.trim(), newVal);
    setNewKey("");
    setNewVal("");
  }, [newKey, newVal, handleSet]);

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Attributes</Label>

      {/* Common attributes for this tag */}
      {commonAttrs.map((attr) => (
        <div key={attr} className="flex gap-1 items-center">
          <span className="text-[10px] text-muted-foreground w-12 shrink-0">{attr}</span>
          <Input
            value={node.attributes[attr] ?? ""}
            onChange={(e) => handleSet(attr, e.target.value)}
            className="h-6 text-[11px] flex-1"
            placeholder={attr}
          />
        </div>
      ))}

      {/* Custom attributes */}
      {Object.entries(node.attributes)
        .filter(([k]) => !commonAttrs.includes(k))
        .map(([key, val]) => (
          <div key={key} className="flex gap-1 items-center group">
            <span className="text-[10px] text-muted-foreground w-12 shrink-0 truncate">{key}</span>
            <Input
              value={val}
              onChange={(e) => handleSet(key, e.target.value)}
              className="h-6 text-[11px] flex-1"
            />
            <button
              type="button"
              onClick={() => handleRemove(key)}
              className="text-[10px] text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}

      {/* Add new */}
      <div className="flex gap-1">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="attr"
          className="h-6 text-[11px] w-16"
        />
        <Input
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          placeholder="value"
          className="h-6 text-[11px] flex-1"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={handleAdd}>
          +
        </Button>
      </div>
    </div>
  );
}

function ClassEditor({ store, node }: { store: PBStore; node: PBNode }) {
  const [input, setInput] = useState("");

  const handleAdd = useCallback(() => {
    const classes = input.trim().split(/\s+/).filter(Boolean);
    if (classes.length === 0) return;
    const merged = twMerge(node.classes.join(" "), classes.join(" "));
    store.updateNode(node.id, { classes: merged.split(" ").filter(Boolean) });
    setInput("");
  }, [store, node.id, node.classes, input]);

  const handleRemove = useCallback(
    (cls: string) => {
      store.updateNode(node.id, {
        classes: node.classes.filter((c) => c !== cls),
      });
    },
    [store, node.id, node.classes]
  );

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Classes ({node.classes.length})
      </Label>

      {node.classes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {node.classes.map((cls) => (
            <Badge key={cls} variant="secondary" className="text-[10px] font-mono px-1.5 py-0 h-5 gap-0.5">
              {cls}
              <button
                type="button"
                onClick={() => handleRemove(cls)}
                className="text-muted-foreground hover:text-destructive ml-0.5"
              >
                ×
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div className="flex gap-1">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleAdd())}
          placeholder="text-xl font-bold..."
          className="h-6 text-[11px]"
        />
        <Button size="sm" variant="outline" className="h-6 text-[10px] px-2" onClick={handleAdd}>
          Add
        </Button>
      </div>
    </div>
  );
}

function StyleEditor({ store, node }: { store: PBStore; node: PBNode }) {
  const entries = Object.entries(node.styles);

  const handleRemove = useCallback(
    (prop: string) => {
      const { [prop]: _, ...rest } = node.styles;
      store.updateNode(node.id, { styles: rest });
    },
    [store, node.id, node.styles]
  );

  const handleClearAll = useCallback(() => {
    store.updateNode(node.id, { styles: {} });
  }, [store, node.id]);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Inline Styles ({entries.length})
        </Label>
        <button
          type="button"
          onClick={handleClearAll}
          className="text-[9px] text-destructive hover:underline"
        >
          Clear all
        </button>
      </div>
      {entries.map(([prop, val]) => (
        <div key={prop} className="flex items-center gap-1 group text-[10px]">
          <code className="text-primary/80 shrink-0">{prop}</code>
          <span className="text-muted-foreground truncate flex-1">: {val}</span>
          <button
            type="button"
            onClick={() => handleRemove(prop)}
            className="opacity-0 group-hover:opacity-100 text-destructive"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
