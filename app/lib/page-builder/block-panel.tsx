import { useState } from "react";
import type { PBBlock } from "./types";
import { cn } from "~/lib/utils";

interface BlockPanelProps {
  blocks: PBBlock[];
}

export function BlockPanel({ blocks }: BlockPanelProps) {
  const categories = Array.from(new Set(blocks.map((b) => b.category))).sort();
  const [openCat, setOpenCat] = useState<string>(categories[0] ?? "");

  return (
    <div>
      {categories.map((cat) => (
        <div key={cat} className="mb-1">
          <button
            type="button"
            onClick={() => setOpenCat(openCat === cat ? "" : cat)}
            className="w-full flex items-center justify-between text-[11px] font-semibold text-muted-foreground py-1 hover:text-foreground"
          >
            {cat}
            <span className="text-[9px]">{openCat === cat ? "▲" : "▼"}</span>
          </button>
          {openCat === cat && (
            <div className="grid grid-cols-2 gap-1.5 pb-2">
              {blocks
                .filter((b) => b.category === cat)
                .map((block) => (
                  <div
                    key={block.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/pb-block-html", block.content);
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    className="flex flex-col items-center gap-1 p-2 rounded-lg border border-border bg-card hover:border-primary/50 cursor-grab active:cursor-grabbing transition-colors"
                  >
                    {block.icon && (
                      <div
                        className="w-6 h-6 text-muted-foreground"
                        dangerouslySetInnerHTML={{ __html: block.icon }}
                      />
                    )}
                    <span className="text-[10px] font-medium text-center leading-tight">
                      {block.label}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
