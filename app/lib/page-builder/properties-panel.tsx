import { useState, useCallback, useEffect, useMemo } from "react";
import type { PBNode } from "./types";
import type { PBStore } from "./store";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { Separator } from "~/components/ui/separator";
import { ScrollArea } from "~/components/ui/scroll-area";
import { twMerge } from "tailwind-merge";
import { cn } from "~/lib/utils";

interface PropertiesPanelProps {
  store: PBStore;
  node: PBNode;
}

type IconLibrary = "fa" | "material" | "bi" | null;

function detectIconLibrary(node: PBNode): IconLibrary {
  const classes = node.classes.join(" ");
  if (classes.includes("fa-")) return "fa";
  if (classes.includes("material-icons")) return "material";
  if (classes.includes("bi-") || classes.includes("bi ")) return "bi";
  return null;
}

export function PropertiesPanel({ store, node }: PropertiesPanelProps) {
  const iconLib = detectIconLibrary(node);

  return (
    <div className="space-y-3">
      {/* Node info */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Element</Label>
        <p className="text-sm font-medium">{node.name ?? node.tag}</p>
        <code className="text-[10px] text-muted-foreground">&lt;{node.tag}&gt;</code>
      </div>

      <Separator />

      {/* Icon picker for icon elements */}
      {iconLib && (
        <>
          <IconPicker store={store} node={node} library={iconLib} />
          <Separator />
        </>
      )}

      {/* Text content — but not for icons */}
      {!iconLib && (node.type === "text" || (!node.children.length && node.editable)) && (
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

// --- Icon data ---

const FA_ICONS = [
  "fa-solid fa-arrow-right", "fa-solid fa-arrow-left", "fa-solid fa-arrow-down", "fa-solid fa-arrow-up",
  "fa-solid fa-chevron-right", "fa-solid fa-chevron-left", "fa-solid fa-chevron-down", "fa-solid fa-chevron-up",
  "fa-solid fa-check", "fa-solid fa-xmark", "fa-solid fa-plus", "fa-solid fa-minus",
  "fa-solid fa-star", "fa-solid fa-heart", "fa-solid fa-thumbs-up", "fa-solid fa-fire",
  "fa-solid fa-bolt", "fa-solid fa-rocket", "fa-solid fa-shield-halved", "fa-solid fa-crown",
  "fa-solid fa-user", "fa-solid fa-users", "fa-solid fa-user-plus", "fa-solid fa-circle-user",
  "fa-solid fa-envelope", "fa-solid fa-phone", "fa-solid fa-location-dot", "fa-solid fa-globe",
  "fa-solid fa-magnifying-glass", "fa-solid fa-gear", "fa-solid fa-sliders", "fa-solid fa-filter",
  "fa-solid fa-house", "fa-solid fa-building", "fa-solid fa-store", "fa-solid fa-landmark",
  "fa-solid fa-cart-shopping", "fa-solid fa-bag-shopping", "fa-solid fa-credit-card", "fa-solid fa-wallet",
  "fa-solid fa-download", "fa-solid fa-upload", "fa-solid fa-cloud", "fa-solid fa-database",
  "fa-solid fa-play", "fa-solid fa-pause", "fa-solid fa-stop", "fa-solid fa-music",
  "fa-solid fa-image", "fa-solid fa-camera", "fa-solid fa-video", "fa-solid fa-file",
  "fa-solid fa-folder", "fa-solid fa-trash", "fa-solid fa-pen", "fa-solid fa-copy",
  "fa-solid fa-link", "fa-solid fa-share", "fa-solid fa-bookmark", "fa-solid fa-bell",
  "fa-solid fa-lock", "fa-solid fa-unlock", "fa-solid fa-eye", "fa-solid fa-eye-slash",
  "fa-solid fa-circle-info", "fa-solid fa-circle-question", "fa-solid fa-circle-check", "fa-solid fa-circle-exclamation",
  "fa-solid fa-triangle-exclamation", "fa-solid fa-ban", "fa-solid fa-clock", "fa-solid fa-calendar",
  "fa-solid fa-chart-line", "fa-solid fa-chart-bar", "fa-solid fa-chart-pie", "fa-solid fa-code",
  "fa-solid fa-terminal", "fa-solid fa-laptop", "fa-solid fa-mobile-screen", "fa-solid fa-desktop",
  "fa-brands fa-github", "fa-brands fa-twitter", "fa-brands fa-linkedin", "fa-brands fa-discord",
  "fa-brands fa-youtube", "fa-brands fa-instagram", "fa-brands fa-facebook", "fa-brands fa-tiktok",
  "fa-brands fa-google", "fa-brands fa-apple", "fa-brands fa-windows", "fa-brands fa-amazon",
  "fa-brands fa-stripe", "fa-brands fa-paypal", "fa-brands fa-figma", "fa-brands fa-slack",
];

const MATERIAL_ICONS = [
  "arrow_forward", "arrow_back", "arrow_downward", "arrow_upward",
  "chevron_right", "chevron_left", "expand_more", "expand_less",
  "check", "close", "add", "remove",
  "star", "favorite", "thumb_up", "whatshot",
  "bolt", "rocket_launch", "shield", "workspace_premium",
  "person", "group", "person_add", "account_circle",
  "mail", "phone", "location_on", "language",
  "search", "settings", "tune", "filter_list",
  "home", "apartment", "storefront", "account_balance",
  "shopping_cart", "shopping_bag", "credit_card", "wallet",
  "download", "upload", "cloud", "storage",
  "play_arrow", "pause", "stop", "music_note",
  "image", "photo_camera", "videocam", "description",
  "folder", "delete", "edit", "content_copy",
  "link", "share", "bookmark", "notifications",
  "lock", "lock_open", "visibility", "visibility_off",
  "info", "help", "check_circle", "error",
  "warning", "block", "schedule", "calendar_today",
  "show_chart", "bar_chart", "pie_chart", "code",
  "terminal", "laptop", "smartphone", "desktop_windows",
];

const BI_ICONS = [
  "bi bi-arrow-right", "bi bi-arrow-left", "bi bi-arrow-down", "bi bi-arrow-up",
  "bi bi-chevron-right", "bi bi-chevron-left", "bi bi-chevron-down", "bi bi-chevron-up",
  "bi bi-check-lg", "bi bi-x-lg", "bi bi-plus-lg", "bi bi-dash-lg",
  "bi bi-star-fill", "bi bi-heart-fill", "bi bi-hand-thumbs-up-fill", "bi bi-fire",
  "bi bi-lightning-fill", "bi bi-rocket-takeoff-fill", "bi bi-shield-fill-check", "bi bi-trophy-fill",
  "bi bi-person", "bi bi-people", "bi bi-person-plus", "bi bi-person-circle",
  "bi bi-envelope", "bi bi-telephone", "bi bi-geo-alt", "bi bi-globe",
  "bi bi-search", "bi bi-gear", "bi bi-sliders", "bi bi-funnel",
  "bi bi-house", "bi bi-building", "bi bi-shop", "bi bi-bank",
  "bi bi-cart", "bi bi-bag", "bi bi-credit-card", "bi bi-wallet2",
  "bi bi-download", "bi bi-upload", "bi bi-cloud", "bi bi-database",
  "bi bi-play-fill", "bi bi-pause-fill", "bi bi-stop-fill", "bi bi-music-note",
  "bi bi-image", "bi bi-camera", "bi bi-camera-video", "bi bi-file-earmark",
  "bi bi-folder", "bi bi-trash", "bi bi-pencil", "bi bi-clipboard",
  "bi bi-link-45deg", "bi bi-share", "bi bi-bookmark", "bi bi-bell",
  "bi bi-lock", "bi bi-unlock", "bi bi-eye", "bi bi-eye-slash",
  "bi bi-info-circle", "bi bi-question-circle", "bi bi-check-circle", "bi bi-exclamation-circle",
  "bi bi-exclamation-triangle", "bi bi-slash-circle", "bi bi-clock", "bi bi-calendar",
  "bi bi-graph-up", "bi bi-bar-chart", "bi bi-pie-chart", "bi bi-code-slash",
  "bi bi-terminal", "bi bi-laptop", "bi bi-phone", "bi bi-display",
  "bi bi-github", "bi bi-twitter-x", "bi bi-linkedin", "bi bi-discord",
  "bi bi-youtube", "bi bi-instagram", "bi bi-facebook", "bi bi-tiktok",
];

function iconDisplayName(icon: string, lib: IconLibrary): string {
  if (lib === "fa") return icon.replace("fa-solid fa-", "").replace("fa-brands fa-", "");
  if (lib === "bi") return icon.replace("bi bi-", "");
  return icon;
}

function IconPicker({
  store,
  node,
  library,
}: {
  store: PBStore;
  node: PBNode;
  library: IconLibrary;
}) {
  const [search, setSearch] = useState("");

  const icons = useMemo(() => {
    if (library === "fa") return FA_ICONS;
    if (library === "material") return MATERIAL_ICONS;
    if (library === "bi") return BI_ICONS;
    return [];
  }, [library]);

  const currentIcon = useMemo(() => {
    if (library === "material") return node.text ?? "";
    // For FA/BI, the icon is in the classes
    const cls = node.classes.filter((c) => {
      if (library === "fa") return c.startsWith("fa-") && c !== "fa-solid" && c !== "fa-brands";
      if (library === "bi") return c.startsWith("bi-");
      return false;
    });
    if (library === "fa") {
      const prefix = node.classes.includes("fa-brands") ? "fa-brands" : "fa-solid";
      return cls.length > 0 ? `${prefix} ${cls[0]}` : "";
    }
    return cls.length > 0 ? `bi ${cls[0]}` : "";
  }, [node.classes, node.text, library]);

  const filtered = useMemo(() => {
    if (!search) return icons;
    const q = search.toLowerCase();
    return icons.filter((icon) => iconDisplayName(icon, library).includes(q));
  }, [icons, search, library]);

  const handleSelect = useCallback(
    (icon: string) => {
      if (library === "material") {
        store.updateNode(node.id, { text: icon });
      } else {
        // Replace icon classes, keep size classes
        const sizeClasses = node.classes.filter((c) => c.startsWith("text-"));
        const newClasses = [...icon.split(" "), ...sizeClasses];
        store.updateNode(node.id, { classes: newClasses });
      }
    },
    [store, node.id, node.classes, library]
  );

  const libLabel = library === "fa" ? "Font Awesome" : library === "material" ? "Material" : "Bootstrap";

  return (
    <div>
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 block">
        {libLabel} Icon
      </Label>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search icons..."
        className="h-7 text-xs mb-2"
      />
      <ScrollArea className="h-48">
        <div className="grid grid-cols-4 gap-1">
          {filtered.map((icon) => {
            const name = iconDisplayName(icon, library);
            const isActive = icon === currentIcon;
            return (
              <button
                key={icon}
                type="button"
                onClick={() => handleSelect(icon)}
                title={name}
                className={cn(
                  "flex flex-col items-center gap-0.5 p-1.5 rounded text-[9px] transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
              >
                {name.length > 8 ? name.slice(0, 8) + "…" : name}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="col-span-4 text-center text-[10px] text-muted-foreground py-4">
              No icons match "{search}"
            </p>
          )}
        </div>
      </ScrollArea>
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
