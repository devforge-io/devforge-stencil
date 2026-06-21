import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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

function isButtonNode(node: PBNode): boolean {
  return (
    node.name === "Button" ||
    (node.tag === "a" && node.classes.some((c) => c.startsWith("bg-") || c === "inline-flex"))
  );
}

export function PropertiesPanel({ store, node }: PropertiesPanelProps) {
  const iconLib = detectIconLibrary(node);
  const isButton = isButtonNode(node);

  return (
    <div className="space-y-3">
      {/* Node info */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Element</Label>
        <p className="text-sm font-medium">{node.name ?? node.tag}</p>
        <code className="text-[10px] text-muted-foreground">&lt;{node.tag}&gt;</code>
      </div>

      <Separator />

      {/* Button style picker */}
      {isButton && (
        <>
          <ButtonStylePicker store={store} node={node} />
          <Separator />
        </>
      )}

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

// --- Button styles ---

interface ButtonStyle {
  id: string;
  label: string;
  classes: string[];
  preview: string; // tailwind classes for the preview swatch
}

const BUTTON_STYLES: ButtonStyle[] = [
  {
    id: "primary",
    label: "Primary",
    classes: ["bg-indigo-500", "hover:bg-indigo-600", "text-white"],
    preview: "bg-indigo-500 text-white",
  },
  {
    id: "secondary",
    label: "Secondary",
    classes: ["bg-gray-200", "hover:bg-gray-300", "text-gray-900", "dark:bg-gray-700", "dark:hover:bg-gray-600", "dark:text-white"],
    preview: "bg-gray-200 text-gray-900",
  },
  {
    id: "success",
    label: "Success",
    classes: ["bg-green-500", "hover:bg-green-600", "text-white"],
    preview: "bg-green-500 text-white",
  },
  {
    id: "danger",
    label: "Danger",
    classes: ["bg-red-500", "hover:bg-red-600", "text-white"],
    preview: "bg-red-500 text-white",
  },
  {
    id: "warning",
    label: "Warning",
    classes: ["bg-yellow-500", "hover:bg-yellow-600", "text-white"],
    preview: "bg-yellow-500 text-white",
  },
  {
    id: "ghost",
    label: "Ghost",
    classes: ["bg-transparent", "hover:bg-gray-100", "text-gray-700", "dark:hover:bg-gray-800", "dark:text-gray-300"],
    preview: "bg-transparent text-gray-700 border border-gray-300",
  },
  {
    id: "outline",
    label: "Outline",
    classes: ["bg-transparent", "border", "border-indigo-500", "text-indigo-500", "hover:bg-indigo-50", "dark:hover:bg-indigo-950"],
    preview: "bg-transparent border border-indigo-500 text-indigo-500",
  },
  {
    id: "outline-white",
    label: "Outline White",
    classes: ["bg-transparent", "border", "border-white", "text-white", "hover:bg-white/10"],
    preview: "bg-gray-800 border border-white text-white",
  },
  {
    id: "dark",
    label: "Dark",
    classes: ["bg-gray-900", "hover:bg-gray-800", "text-white", "dark:bg-white", "dark:hover:bg-gray-100", "dark:text-gray-900"],
    preview: "bg-gray-900 text-white",
  },
  {
    id: "gradient",
    label: "Gradient",
    classes: ["bg-gradient-to-r", "from-indigo-500", "to-purple-500", "hover:from-indigo-600", "hover:to-purple-600", "text-white"],
    preview: "bg-gradient-to-r from-indigo-500 to-purple-500 text-white",
  },
];

const BUTTON_SIZES: { id: string; label: string; classes: string[] }[] = [
  { id: "xs", label: "XS", classes: ["px-3", "py-1", "text-xs"] },
  { id: "sm", label: "SM", classes: ["px-4", "py-1.5", "text-sm"] },
  { id: "md", label: "MD", classes: ["px-6", "py-3", "text-base", "font-medium"] },
  { id: "lg", label: "LG", classes: ["px-8", "py-4", "text-lg", "font-medium"] },
];

const BUTTON_ROUNDNESS: { id: string; label: string; cls: string }[] = [
  { id: "none", label: "Square", cls: "rounded-none" },
  { id: "sm", label: "Slight", cls: "rounded" },
  { id: "md", label: "Medium", cls: "rounded-lg" },
  { id: "lg", label: "Large", cls: "rounded-xl" },
  { id: "full", label: "Pill", cls: "rounded-full" },
];

// Classes that belong to button style/size/roundness and should be stripped when changing
const BUTTON_STYLE_CLASSES = new Set(
  BUTTON_STYLES.flatMap((s) => s.classes)
    .concat(BUTTON_SIZES.flatMap((s) => s.classes))
    .concat(BUTTON_ROUNDNESS.map((r) => r.cls))
);

function detectCurrentStyle(node: PBNode): string {
  for (const style of BUTTON_STYLES) {
    // Check if at least the bg class matches
    const bgClass = style.classes.find((c) => c.startsWith("bg-") && !c.startsWith("bg-transparent") && !c.startsWith("bg-gradient"));
    const gradClass = style.classes.find((c) => c.startsWith("from-"));
    if (bgClass && node.classes.includes(bgClass)) return style.id;
    if (gradClass && node.classes.includes(gradClass)) return style.id;
    if (style.id === "ghost" && node.classes.includes("bg-transparent") && !node.classes.some((c) => c === "border")) return style.id;
    if (style.id === "outline" && node.classes.includes("border-indigo-500")) return style.id;
    if (style.id === "outline-white" && node.classes.includes("border-white") && node.classes.includes("text-white")) return style.id;
  }
  return "primary";
}

function detectCurrentSize(node: PBNode): string {
  for (const size of BUTTON_SIZES) {
    if (size.classes.every((c) => node.classes.includes(c))) return size.id;
  }
  return "md";
}

function detectCurrentRoundness(node: PBNode): string {
  for (const r of BUTTON_ROUNDNESS) {
    if (node.classes.includes(r.cls)) return r.id;
  }
  return "md";
}

function ButtonStylePicker({ store, node }: { store: PBStore; node: PBNode }) {
  const currentStyle = detectCurrentStyle(node);
  const currentSize = detectCurrentSize(node);
  const currentRoundness = detectCurrentRoundness(node);

  const applyStyle = useCallback(
    (styleId: string) => {
      const style = BUTTON_STYLES.find((s) => s.id === styleId);
      if (!style) return;
      const kept = node.classes.filter((c) => !BUTTON_STYLE_CLASSES.has(c));
      // Re-add size and roundness
      const size = BUTTON_SIZES.find((s) => s.id === currentSize) ?? BUTTON_SIZES[2];
      const round = BUTTON_ROUNDNESS.find((r) => r.id === currentRoundness) ?? BUTTON_ROUNDNESS[2];
      store.updateNode(node.id, { classes: [...kept, ...style.classes, ...size.classes, round.cls] });
    },
    [store, node, currentSize, currentRoundness]
  );

  const applySize = useCallback(
    (sizeId: string) => {
      const size = BUTTON_SIZES.find((s) => s.id === sizeId);
      if (!size) return;
      const style = BUTTON_STYLES.find((s) => s.id === currentStyle) ?? BUTTON_STYLES[0];
      const round = BUTTON_ROUNDNESS.find((r) => r.id === currentRoundness) ?? BUTTON_ROUNDNESS[2];
      const kept = node.classes.filter((c) => !BUTTON_STYLE_CLASSES.has(c));
      store.updateNode(node.id, { classes: [...kept, ...style.classes, ...size.classes, round.cls] });
    },
    [store, node, currentStyle, currentRoundness]
  );

  const applyRoundness = useCallback(
    (roundId: string) => {
      const round = BUTTON_ROUNDNESS.find((r) => r.id === roundId);
      if (!round) return;
      const style = BUTTON_STYLES.find((s) => s.id === currentStyle) ?? BUTTON_STYLES[0];
      const size = BUTTON_SIZES.find((s) => s.id === currentSize) ?? BUTTON_SIZES[2];
      const kept = node.classes.filter((c) => !BUTTON_STYLE_CLASSES.has(c));
      store.updateNode(node.id, { classes: [...kept, ...style.classes, ...size.classes, round.cls] });
    },
    [store, node, currentStyle, currentSize]
  );

  return (
    <div className="space-y-3">
      {/* Style */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 block">Button Style</Label>
        <div className="grid grid-cols-5 gap-1">
          {BUTTON_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              onClick={() => applyStyle(style.id)}
              title={style.label}
              className={cn(
                "h-7 rounded text-[9px] font-medium transition-all",
                style.preview,
                currentStyle === style.id ? "ring-2 ring-primary ring-offset-1" : "opacity-80 hover:opacity-100"
              )}
            >
              {style.label}
            </button>
          ))}
        </div>
      </div>

      {/* Size */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 block">Size</Label>
        <div className="flex gap-1">
          {BUTTON_SIZES.map((size) => (
            <button
              key={size.id}
              type="button"
              onClick={() => applySize(size.id)}
              className={cn(
                "flex-1 h-7 rounded text-[10px] font-medium border transition-colors",
                currentSize === size.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-transparent hover:text-foreground"
              )}
            >
              {size.label}
            </button>
          ))}
        </div>
      </div>

      {/* Roundness */}
      <div>
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5 block">Corners</Label>
        <div className="flex gap-1">
          {BUTTON_ROUNDNESS.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => applyRoundness(r.id)}
              className={cn(
                "flex-1 h-7 text-[10px] font-medium border transition-colors",
                r.cls,
                currentRoundness === r.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted text-muted-foreground border-transparent hover:text-foreground"
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
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
    node.tag === "img" ? ["src", "alt"] :
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

  const isImage = node.tag === "img";

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Attributes</Label>

      {/* Image source picker for img elements */}
      {isImage && (
        <ImageSourcePicker
          value={node.attributes.src ?? ""}
          onChange={(url) => handleSet("src", url)}
        />
      )}

      {/* Common attributes for this tag (skip src for img — handled above) */}
      {commonAttrs.filter((a) => !(isImage && a === "src")).map((attr) => (
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
        .filter(([k]) => !commonAttrs.includes(k) && !(isImage && k === "src"))
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

// --- Image source picker ---

interface AssetItem {
  name: string;
  url: string;
  size: number;
  commitSha: string;
}

async function uploadFile(file: File): Promise<string | null> {
  const formData = new FormData();
  formData.append("file", file);
  try {
    const res = await fetch("/api/assets/upload", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) return null;
    const { url, commitSha } = await res.json();
    return commitSha ? `${url}?ref=${commitSha}` : url;
  } catch {
    return null;
  }
}

function ImageSourcePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (url: string) => void;
}) {
  const [mode, setMode] = useState<"current" | "browse" | "upload" | "url">("current");
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadAssets = useCallback(() => {
    setLoadingAssets(true);
    fetch("/api/assets")
      .then((r) => r.json())
      .then((data) => {
        setAssets(data.assets ?? []);
        setLoadingAssets(false);
      })
      .catch(() => setLoadingAssets(false));
  }, []);

  const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
  const isImage = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    return imageExtensions.has(ext);
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);
      const url = await uploadFile(file);
      if (url) {
        onChange(url);
        setMode("current");
      }
      setUploading(false);
      e.target.value = "";
    },
    [onChange]
  );

  // Preview of current src
  const hasValue = value && !value.startsWith("data:image/svg+xml");

  return (
    <div className="space-y-1.5">
      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Image Source</Label>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Current value preview */}
      {hasValue && mode === "current" && (
        <div className="border border-border rounded overflow-hidden">
          <img
            src={value}
            alt="current"
            className="w-full h-20 object-cover bg-muted"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div className="px-1.5 py-1">
            <p className="text-[9px] text-muted-foreground truncate">{value}</p>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {mode === "current" && (
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 flex-1"
            onClick={() => { setMode("browse"); loadAssets(); }}
          >
            Browse
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 flex-1"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 flex-1"
            onClick={() => { setUrlInput(value); setMode("url"); }}
          >
            URL
          </Button>
        </div>
      )}

      {/* Browse assets */}
      {mode === "browse" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium">Assets</span>
            <button type="button" onClick={() => setMode("current")} className="text-[10px] text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-2 py-1.5 border border-dashed border-border rounded text-[10px] text-muted-foreground hover:border-primary hover:text-primary transition-colors"
          >
            + Upload new file
          </button>
          {loadingAssets ? (
            <p className="text-[10px] text-muted-foreground text-center py-3">Loading...</p>
          ) : assets.filter((a) => isImage(a.name)).length === 0 ? (
            <p className="text-[10px] text-muted-foreground text-center py-3">No image assets found.</p>
          ) : (
            <ScrollArea className="h-40">
              <div className="grid grid-cols-3 gap-1">
                {assets.filter((a) => isImage(a.name)).map((asset) => (
                  <button
                    key={asset.name}
                    type="button"
                    onClick={() => {
                      const url = asset.commitSha ? `${asset.url}?ref=${asset.commitSha}` : asset.url;
                      onChange(url);
                      setMode("current");
                    }}
                    className="group border border-border rounded overflow-hidden hover:border-primary transition-colors text-left"
                  >
                    <img
                      src={asset.url}
                      alt={asset.name}
                      className="w-full h-14 object-cover"
                    />
                    <p className="text-[8px] text-muted-foreground truncate px-1 py-0.5">
                      {asset.name}
                    </p>
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      {/* URL input */}
      {mode === "url" && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium">Image URL</span>
            <button type="button" onClick={() => setMode("current")} className="text-[10px] text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
          <div className="flex gap-1">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://..."
              className="h-6 text-[11px] flex-1"
              onKeyDown={(e) => {
                if (e.key === "Enter" && urlInput.trim()) {
                  onChange(urlInput.trim());
                  setMode("current");
                }
              }}
            />
            <Button
              size="sm"
              variant="default"
              className="h-6 text-[10px] px-2"
              disabled={!urlInput.trim()}
              onClick={() => { onChange(urlInput.trim()); setMode("current"); }}
            >
              Set
            </Button>
          </div>
        </div>
      )}

      {uploading && (
        <p className="text-[10px] text-primary animate-pulse">Uploading...</p>
      )}
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

  const [copied, setCopied] = useState(false);
  const copyClasses = useCallback(() => {
    navigator.clipboard.writeText(node.classes.join(" "));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [node.classes]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Classes ({node.classes.length})
        </Label>
        {node.classes.length > 0 && (
          <button
            type="button"
            onClick={copyClasses}
            className="text-[9px] text-muted-foreground hover:text-foreground transition-colors"
            title="Copy all classes"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        )}
      </div>

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
