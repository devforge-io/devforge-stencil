import { Suspense, lazy, useState } from "react";
import { cn } from "~/lib/utils";
import { SELECT_CLS, type ComponentChoice, type TargetDraft } from "./conditional-model";

// The visual designer pulls in the whole page-builder canvas — load it on demand.
const ComponentDesignerModal = lazy(() => import("./component-designer"));

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** A reusable component loaded for in-place editing in the visual designer. */
interface EditingComponent {
  slug: string;
  name: string;
  html: string;
  css: string;
}

/**
 * Picks what a branch renders. Three ways:
 *   - **Select component** — reuse an existing component (incl. other conditionals).
 *     A selected (non-conditional) component can be **edited in place** here —
 *     opening the visual designer on it and saving back to the shared component.
 *   - **Design** — build the markup visually here (stored as an inline target),
 *     with the option to promote it to a reusable component.
 *
 * Shared by the properties-panel list editor and the flow-canvas target nodes.
 * `nodrag`/`nowheel` stop React Flow hijacking interaction inside a node.
 */
export function TargetEditor({
  target,
  components,
  onChange,
}: {
  target: TargetDraft;
  components: ComponentChoice[];
  onChange: (t: TargetDraft) => void;
}) {
  const isInline = target.kind === "inline";
  const [showDesigner, setShowDesigner] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  // Components created via "save as component" before the parent list refreshes.
  const [extra, setExtra] = useState<ComponentChoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The existing component currently open in the designer for in-place editing.
  const [editing, setEditing] = useState<EditingComponent | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);

  const allComponents = dedupe([...components, ...extra]);
  const selected = target.kind === "component" && target.slug ? allComponents.find((c) => c.slug === target.slug) : undefined;
  // Conditionals have no markup of their own, so they can't be edited here.
  const canEditSelected = target.kind === "component" && !!target.slug && selected?.type !== "conditional";

  const saveAsComponent = async (name: string, html: string, css: string, projectData: string) => {
    setError(null);
    const slug = slugify(name);
    if (!slug) throw new Error("Invalid name");
    const res = await fetch("/api/components", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, name, category: "Custom", html, css, projectData }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Could not save component");
    }
    setExtra((prev) => dedupe([...prev, { slug, name, type: "static" }]));
    onChange({ kind: "component", slug });
    setShowDesigner(false);
  };

  // Load the selected component's markup and open the designer on it.
  const openEditSelected = async () => {
    if (target.kind !== "component" || !target.slug) return;
    setError(null);
    setLoadingEdit(true);
    try {
      const { component } = await fetch(`/api/components/${target.slug}`).then((r) => r.json());
      if (!component) throw new Error("Component not found");
      setEditing({ slug: component.slug, name: component.name, html: component.html ?? "", css: component.css ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load component");
    } finally {
      setLoadingEdit(false);
    }
  };

  // Write the designer's output back to the shared component (re-reading a fresh
  // sha first). Updates it everywhere it's used.
  const saveEditedComponent = async (html: string, css: string, projectData: string) => {
    if (!editing) return;
    const { component: comp } = await fetch(`/api/components/${editing.slug}`).then((r) => r.json());
    if (!comp) throw new Error("Component not found");
    const res = await fetch(`/api/components/${editing.slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: comp.name,
        category: comp.category,
        icon: comp.icon,
        description: comp.description,
        html,
        css,
        projectData,
        sha: comp.sha,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Could not save component");
    }
    setEditing(null);
  };

  return (
    <div className="nodrag nowheel space-y-1">
      <div className="flex gap-1">
        <TabBtn
          active={!isInline}
          onClick={() => onChange({ kind: "component", slug: target.kind === "component" ? target.slug : "" })}
        >
          Select component
        </TabBtn>
        <TabBtn
          active={isInline}
          onClick={() => onChange({ kind: "inline", html: isInline ? target.html : "", css: isInline ? target.css : "" })}
        >
          Design
        </TabBtn>
      </div>

      {target.kind === "component" ? (
        <div className="space-y-1">
          <select className={SELECT_CLS} value={target.slug} onChange={(e) => onChange({ kind: "component", slug: e.target.value })}>
            <option value="">— choose component —</option>
            {allComponents.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
                {c.type === "conditional" ? " (conditional)" : ""}
              </option>
            ))}
          </select>
          {canEditSelected && (
            <>
              <button
                type="button"
                onClick={openEditSelected}
                disabled={loadingEdit}
                className="w-full rounded-md border border-primary/40 bg-primary/5 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {loadingEdit ? "Loading…" : `✏️ Edit ${selected?.name ?? "component"}`}
              </button>
              <p className="text-[9px] leading-snug text-amber-600">
                ⚠ Edits this component everywhere it’s used.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">
            {target.html.trim() ? `Designed inline (${target.html.length} chars)` : "Empty — open the designer to build it."}
          </p>
          <button
            type="button"
            onClick={() => setShowDesigner(true)}
            className="w-full rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/10"
          >
            ✏️ Open visual designer
          </button>

          <button type="button" onClick={() => setShowRaw((v) => !v)} className="text-[10px] text-muted-foreground hover:text-foreground">
            {showRaw ? "▾ hide raw HTML" : "▸ edit raw HTML"}
          </button>
          {showRaw && (
            <>
              <textarea
                className="h-20 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[10px] shadow-sm"
                placeholder="<div class='p-4'>…</div>"
                value={target.html}
                onChange={(e) => onChange({ kind: "inline", html: e.target.value, css: target.css })}
              />
              <textarea
                className="h-12 w-full rounded-md border border-input bg-transparent px-2 py-1 font-mono text-[10px] shadow-sm"
                placeholder="/* optional CSS */"
                value={target.css}
                onChange={(e) => onChange({ kind: "inline", html: target.html, css: e.target.value })}
              />
            </>
          )}
        </div>
      )}

      {error && <p className="text-[10px] text-destructive">{error}</p>}

      {showDesigner && (
        <Suspense fallback={null}>
          <ComponentDesignerModal
            title="Design this outcome"
            initialHtml={target.kind === "inline" ? target.html : ""}
            initialCss={target.kind === "inline" ? target.css : ""}
            onApply={(html, css) => {
              onChange({ kind: "inline", html, css });
              setShowDesigner(false);
            }}
            onSaveAsComponent={saveAsComponent}
            onClose={() => setShowDesigner(false)}
          />
        </Suspense>
      )}

      {editing && (
        <Suspense fallback={null}>
          <ComponentDesignerModal
            title={`Edit “${editing.name}” — shared component`}
            initialHtml={editing.html}
            initialCss={editing.css}
            applyLabel="Save component"
            onApply={saveEditedComponent}
            onClose={() => setEditing(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

function dedupe(list: ComponentChoice[]): ComponentChoice[] {
  const seen = new Set<string>();
  const out: ComponentChoice[] = [];
  for (const c of list) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    out.push(c);
  }
  return out;
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
