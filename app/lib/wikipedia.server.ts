import matter from "gray-matter";
import type { ContentFrontmatter, ParsedContent } from "./markdown.server";

export interface ParsedWikipedia extends ParsedContent {}

export async function parseWikipedia(raw: string): Promise<ParsedWikipedia> {
  const { data, content } = matter(raw);
  const html = wikitextToHtml(content.trim());

  return {
    frontmatter: {
      title: data.title ?? "Untitled",
      description: data.description,
      tags: data.tags,
      publishedAt: data.publishedAt,
      updatedAt: data.updatedAt,
      draft: data.draft ?? false,
      contentType: "wikipedia",
      ...data,
    },
    html,
    raw,
  };
}

export function renderWikitextBody(body: string): string {
  return wikitextToHtml(body);
}

// ---------------------------------------------------------------------------
// Image resolution: local assets with Wikimedia Commons fallback
// ---------------------------------------------------------------------------

function resolveImageSrc(filename: string): string {
  if (filename.startsWith("http") || filename.startsWith("/api/")) return filename;
  const local = `/api/assets/${encodeURIComponent(filename)}`;
  const commons = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename.replace(/ /g, "_"))}`;
  // onerror fallback to Wikimedia Commons
  return `${local}" onerror="this.onerror=null;this.src='${commons}'`;
}

// ---------------------------------------------------------------------------
// Citation / reference collector
// ---------------------------------------------------------------------------

interface RefCollector {
  refs: Array<{ name?: string; text: string }>;
  namedRefs: Map<string, number>;
  add(name: string | undefined, text: string): number;
  getIndex(name: string): number | undefined;
}

/**
 * Render the content inside a <ref> tag to readable HTML.
 * Handles {{Cite web|...}}, {{Cite journal|...}}, etc.
 */
function renderRefContent(raw: string): string {
  // Check if it's a cite template
  const tplMatch = raw.match(/^\{\{([^|}]+)(?:\|[\s\S]*)?\}\}$/);
  if (!tplMatch) return raw; // plain text citation

  const inner = raw.slice(2, -2);
  const parts = splitTemplateParts(inner);
  const tplName = parts[0].trim();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const eqIdx = part.indexOf("=");
    if (eqIdx > 0) {
      params[part.slice(0, eqIdx).trim().toLowerCase()] = part.slice(eqIdx + 1).trim();
    }
  }

  // Build a readable citation string
  const pieces: string[] = [];

  // Author(s)
  const author = params.author || params.last;
  if (author) {
    const first = params.first ?? "";
    pieces.push(first ? `${author}, ${first}` : author);
  }

  // Date
  if (params.date) pieces.push(`(${params.date})`);
  else if (params.year) pieces.push(`(${params.year})`);

  // Title with link
  if (params.title) {
    if (params.url) {
      pieces.push(`<a href="${escapeAttr(params.url)}" rel="nofollow" class="external">"${params.title}"</a>`);
    } else {
      pieces.push(`"${params.title}"`);
    }
  }

  // Website / journal / publisher
  if (params.website) pieces.push(`<em>${params.website}</em>`);
  else if (params.journal) pieces.push(`<em>${params.journal}</em>`);
  else if (params.work) pieces.push(`<em>${params.work}</em>`);
  if (params.publisher) pieces.push(params.publisher);

  // Access date
  if (params["access-date"]) pieces.push(`Retrieved ${params["access-date"]}`);
  else if (params.accessdate) pieces.push(`Retrieved ${params.accessdate}`);

  if (pieces.length > 0) return pieces.join(". ").replace(/\.\./g, ".") + ".";

  // Fallback: just show template name
  return `${tplName}: ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}`;
}

function createRefCollector(): RefCollector {
  const refs: Array<{ name?: string; text: string }> = [];
  const namedRefs = new Map<string, number>();
  return {
    refs,
    namedRefs,
    add(name, text) {
      if (name && namedRefs.has(name)) return namedRefs.get(name)!;
      const idx = refs.length;
      refs.push({ name, text });
      if (name) namedRefs.set(name, idx);
      return idx;
    },
    getIndex(name) { return namedRefs.get(name); },
  };
}

function renderReferencesSection(collector: RefCollector): string {
  if (collector.refs.length === 0) return "";
  const items = collector.refs.map((r, i) =>
    `<li id="cite-note-${i + 1}"><span class="wiki-refback"><a href="#cite-ref-${i + 1}">&uarr;</a></span> ${r.text}</li>`
  ).join("\n");
  return `\n<div class="wiki-references" contenteditable="false">
<h2>References</h2>
<ol class="wiki-reflist">\n${items}\n</ol>
</div>`;
}

// ---------------------------------------------------------------------------
// Template processing
// ---------------------------------------------------------------------------

interface TemplateParam { key: string; value: string; }

function extractTemplates(text: string): { result: string; templates: Array<{ name: string; params: TemplateParam[]; raw: string }> } {
  const templates: Array<{ name: string; params: TemplateParam[]; raw: string }> = [];
  let result = text;
  let safety = 0;

  while (safety++ < 100) {
    const startIdx = result.indexOf("{{");
    if (startIdx === -1) break;

    let depth = 0;
    let endIdx = -1;
    for (let i = startIdx; i < result.length - 1; i++) {
      if (result[i] === "{" && result[i + 1] === "{") { depth++; i++; }
      else if (result[i] === "}" && result[i + 1] === "}") {
        depth--; i++;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    if (endIdx === -1) break;

    const inner = result.slice(startIdx + 2, endIdx - 2);
    const parts = splitTemplateParts(inner);
    const name = parts[0].trim();
    const params: TemplateParam[] = [];
    for (let p = 1; p < parts.length; p++) {
      const part = parts[p];
      const eqIdx = part.indexOf("=");
      if (eqIdx > 0) {
        params.push({ key: part.slice(0, eqIdx).trim(), value: part.slice(eqIdx + 1).trim() });
      } else {
        params.push({ key: String(p), value: part.trim() });
      }
    }

    const rawTpl = result.slice(startIdx, endIdx);
    templates.push({ name, params, raw: rawTpl });
    result = result.slice(0, startIdx) + `\x00TPL${templates.length - 1}\x00` + result.slice(endIdx);
  }

  return { result, templates };
}

function splitTemplateParts(inner: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    const c2 = i < inner.length - 1 ? inner[i + 1] : "";
    if ((c === "[" && c2 === "[") || (c === "{" && c2 === "{")) { depth++; current += c + c2; i++; continue; }
    if ((c === "]" && c2 === "]") || (c === "}" && c2 === "}")) { depth--; current += c + c2; i++; continue; }
    if (c === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);
  return parts;
}

function renderTemplate(name: string, params: TemplateParam[], refCollector: RefCollector, rawSrc?: string): string {
  const lname = name.toLowerCase().replace(/\s+/g, " ").trim();
  const srcAttr = rawSrc ? ` data-wiki-tpl="${escapeAttr(rawSrc)}"` : "";

  if (lname === "short description") {
    return `<div class="wiki-short-description"${srcAttr} contenteditable="false">${inlineFormat(params[0]?.value ?? "", refCollector)}</div>`;
  }

  if (lname === "url") {
    const url = params[0]?.value ?? "";
    const display = params[1]?.value ?? url.replace(/^https?:\/\//, "");
    return `<a href="${escapeAttr(url)}" rel="nofollow" class="external">${display}</a>`;
  }

  if (lname === "start date and age") {
    const year = params[0]?.value ?? "";
    const month = params[1]?.value ?? "";
    const day = params[2]?.value ?? "";
    const dateStr = day ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}` : `${year}-${month.padStart(2, "0")}`;
    return `<time datetime="${dateStr}">${dateStr}</time>`;
  }

  if (lname.startsWith("infobox")) return renderInfobox(name, params, refCollector, rawSrc);

  if (lname === "citation needed" || lname === "cn") {
    return `<sup class="wiki-ref" title="Citation needed">[citation&nbsp;needed]</sup>`;
  }

  if (lname === "as of") {
    return `as of ${params.map((p) => p.value).join("-")}`;
  }

  // {{reflist}} or {{references}} — placeholder for reference section (generated automatically)
  if (lname === "reflist" || lname === "references") {
    return `\x00REFLIST\x00`;
  }

  const paramStr = params.map((p) => p.value).join(", ");
  return `<span class="wiki-template" title="Template: ${escapeAttr(name)}">${paramStr || name}</span>`;
}

function renderInfobox(name: string, params: TemplateParam[], refCollector: RefCollector, rawSrc?: string): string {
  const title = name.replace(/^[Ii]nfobox\s*/, "");
  let rows = "";
  let infoboxName = "";
  let headerImage = "";

  for (const p of params) {
    const val = inlineFormat(p.value, refCollector);
    if (!val) continue;

    if (p.key === "name") { infoboxName = val; continue; }
    if (p.key === "logo" || p.key === "image") { headerImage = val; continue; }

    const label = p.key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    rows += `<tr><th class="wiki-infobox-label">${label}</th><td class="wiki-infobox-value">${val}</td></tr>`;
  }

  const nameRow = infoboxName ? `<tr><th colspan="2" class="wiki-infobox-title">${infoboxName}</th></tr>` : "";
  const imageRow = headerImage ? `<tr><td colspan="2" class="wiki-infobox-image">${headerImage}</td></tr>` : "";

  const srcAttr = rawSrc ? ` data-wiki-tpl="${escapeAttr(rawSrc)}"` : "";
  return `<aside class="wiki-infobox" contenteditable="false"${srcAttr}>
<table>
<caption>${escapeHtml(title || "Info")}</caption>
${nameRow}${imageRow}${rows}
</table>
</aside>`;
}

// ---------------------------------------------------------------------------
// Main converter
// ---------------------------------------------------------------------------

function wikitextToHtml(wikitext: string): string {
  const refCollector = createRefCollector();

  // Protect nowiki / pre
  const nowikiBlocks: string[] = [];
  let text = wikitext.replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, (_m, c) => {
    nowikiBlocks.push(c); return `\x00NOWIKI${nowikiBlocks.length - 1}\x00`;
  });
  const preBlocks: string[] = [];
  text = text.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_m, c) => {
    preBlocks.push(c); return `\x00PRE${preBlocks.length - 1}\x00`;
  });

  // Protect <ref> content from template extraction — store raw ref content
  const refBlocks: string[] = [];
  text = text.replace(/<ref(\s+name="[^"]*")?\s*>([\s\S]*?)<\/ref>/gi, (_m, nameAttr, content) => {
    refBlocks.push(_m); // store the full <ref>...</ref> tag
    return `\x00REF${refBlocks.length - 1}\x00`;
  });

  // Extract templates (refs are now protected)
  const { result: afterTpl, templates } = extractTemplates(text);
  text = afterTpl;

  // Restore ref blocks after template extraction
  text = text.replace(/\x00REF(\d+)\x00/g, (_m, idx) => refBlocks[Number(idx)]);

  // Render templates
  const renderedTpls = templates.map((t) => renderTemplate(t.name, t.params, refCollector, t.raw));

  // Line-by-line parsing
  const lines = text.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Template placeholder on own line
    const tplMatch = line.trim().match(/^\x00TPL(\d+)\x00$/);
    if (tplMatch) { output.push(renderedTpls[Number(tplMatch[1])]); i++; continue; }

    if (/^-{4,}\s*$/.test(line)) { output.push("<hr />"); i++; continue; }

    // Table
    if (line.trimStart().startsWith("{|")) {
      const tbl: string[] = [line]; i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("|}")) { tbl.push(lines[i]); i++; }
      if (i < lines.length) tbl.push(lines[i++]);
      output.push(parseTable(tbl, refCollector)); continue;
    }

    // Heading
    const hm = line.match(/^(={1,6})\s*(.+?)\s*\1\s*$/);
    if (hm) { output.push(`<h${hm[1].length}>${inlineFormat(hm[2], refCollector)}</h${hm[1].length}>`); i++; continue; }

    // Lists
    if (line.startsWith("*")) { const ll: string[] = []; while (i < lines.length && lines[i].startsWith("*")) ll.push(lines[i++]); output.push(parseList(ll, "*", "ul", refCollector)); continue; }
    if (line.startsWith("#") && !line.startsWith("#REDIRECT")) { const ll: string[] = []; while (i < lines.length && lines[i].startsWith("#")) ll.push(lines[i++]); output.push(parseList(ll, "#", "ol", refCollector)); continue; }

    // Definition list
    if (line.startsWith(";")) { const dl: string[] = []; while (i < lines.length && (lines[i].startsWith(";") || lines[i].startsWith(":"))) dl.push(lines[i++]); output.push(parseDL(dl, refCollector)); continue; }

    // Indent
    if (line.startsWith(":")) {
      const lvl = line.match(/^(:+)/)![1].length;
      output.push(`<div style="margin-left:${lvl * 2}em">${inlineFormat(line.replace(/^:+\s*/, ""), refCollector)}</div>`);
      i++; continue;
    }

    if (line.trim() === "") { i++; continue; }

    // Paragraph
    const pl: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" &&
      !lines[i].startsWith("=") && !lines[i].startsWith("*") && !lines[i].startsWith("#") &&
      !lines[i].startsWith(";") && !lines[i].startsWith(":") &&
      !lines[i].trimStart().startsWith("{|") && !/^-{4,}\s*$/.test(lines[i]) &&
      !/^\x00TPL\d+\x00$/.test(lines[i].trim())
    ) { pl.push(lines[i]); i++; }
    if (pl.length > 0) output.push(`<p>${inlineFormat(pl.join("\n"), refCollector)}</p>`);
  }

  let html = output.join("\n");

  // Inline template placeholders
  html = html.replace(/\x00TPL(\d+)\x00/g, (_m, idx) => renderedTpls[Number(idx)]);

  // Restore pre/nowiki
  html = html.replace(/\x00PRE(\d+)\x00/g, (_m, idx) => `<pre><code>${escapeHtml(preBlocks[Number(idx)])}</code></pre>`);
  html = html.replace(/\x00NOWIKI(\d+)\x00/g, (_m, idx) => escapeHtml(nowikiBlocks[Number(idx)]));

  // Insert references section
  const refsHtml = renderReferencesSection(refCollector);
  if (html.includes("\x00REFLIST\x00")) {
    html = html.replace(/\x00REFLIST\x00/g, refsHtml);
  } else if (refsHtml) {
    html += refsHtml;
  }

  return html;
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

function inlineFormat(text: string, refCollector: RefCollector): string {
  // Bold + italic
  text = text.replace(/'''''(.+?)'''''/g, "<strong><em>$1</em></strong>");
  text = text.replace(/'''(.+?)'''/g, "<strong>$1</strong>");
  text = text.replace(/''(.+?)''/g, "<em>$1</em>");

  // Refs: <ref name="x">text</ref>
  text = text.replace(/<ref(?:\s+name="([^"]*)")?\s*>([\s\S]*?)<\/ref>/gi, (_m, name, content) => {
    const rawContent = content.trim();
    const rendered = renderRefContent(rawContent);
    const idx = refCollector.add(name || undefined, rendered);
    const nameAttr = name ? ` data-ref-name="${escapeAttr(name)}"` : "";
    return `<sup class="wiki-cite" data-ref-text="${escapeAttr(rawContent)}"${nameAttr}><a href="#cite-note-${idx + 1}" id="cite-ref-${idx + 1}">[${idx + 1}]</a></sup>`;
  });

  // Self-closing ref: <ref name="x" />
  text = text.replace(/<ref\s+name="([^"]*)"\s*\/>/gi, (_m, name) => {
    const idx = refCollector.getIndex(name);
    if (idx !== undefined) {
      return `<sup class="wiki-cite" data-ref-name="${escapeAttr(name)}"><a href="#cite-note-${idx + 1}">[${idx + 1}]</a></sup>`;
    }
    return `<sup class="wiki-cite">[?]</sup>`;
  });

  // Images
  text = text.replace(/\[\[(?:File|Image):([^\]|]+?)(?:\|([^\]]*))?\]\]/gi, (_m, file, opts) => {
    const src = resolveImageSrc(file.trim());
    const options = opts ? opts.split("|").map((o: string) => o.trim()) : [];
    const layoutOpts = ["thumb", "thumbnail", "frame", "frameless", "left", "right", "center", "none"];
    const caption = options.filter((o: string) => !layoutOpts.includes(o) && !o.match(/^\d+px$/)).pop() ?? "";
    const isThumb = options.includes("thumb") || options.includes("thumbnail");
    const classes: string[] = ["wiki-image"];
    if (isThumb) classes.push("wiki-thumb");
    const floatDir = options.includes("left") ? "left" : (options.includes("right") || isThumb) ? "right" : options.includes("center") ? "center" : "";
    const widthOpt = options.find((o: string) => o.match(/^\d+px$/));
    const style = widthOpt ? ` style="width:${widthOpt}"` : "";
    const alt = caption ? ` alt="${escapeAttr(caption)}"` : "";
    const imgTag = `<img src="${src}" class="${classes.join(" ")}"${alt}${style} />`;

    if (caption || isThumb) {
      const figClass = ["wiki-figure"];
      if (floatDir === "left") figClass.push("float-left", "mr-4");
      else if (floatDir === "right") figClass.push("float-right", "ml-4");
      else if (floatDir === "center") figClass.push("mx-auto");
      return `<figure class="${figClass.join(" ")}">${imgTag}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
    }
    return imgTag;
  });

  // Internal links
  text = text.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target, label) => {
    const href = target.trim().replace(/\s+/g, "_");
    return `<a href="${escapeAttr(href)}" class="wiki-link">${(label ?? target).trim()}</a>`;
  });

  // External links
  text = text.replace(/\[(\w+:\/\/[^\s\]]+)\s*([^\]]*?)\]/g, (_m, url, label) =>
    `<a href="${escapeAttr(url)}" rel="nofollow" class="external">${label.trim() || url}</a>`
  );

  // Bare URLs
  text = text.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_m, pre, url) =>
    `${pre}<a href="${escapeAttr(url)}" rel="nofollow">${url}</a>`
  );

  // Inline template placeholders
  text = text.replace(/\x00TPL(\d+)\x00/g, "<!-- tpl -->"); // handled later

  text = text.replace(/<br\s*\/?>/gi, "<br />");
  return text;
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

function parseList(lines: string[], marker: string, tag: "ul" | "ol", rc: RefCollector): string {
  return `<${tag}>${lines.map((l) => `<li>${inlineFormat(l.replace(new RegExp(`^\\${marker}+\\s*`), ""), rc)}</li>`).join("")}</${tag}>`;
}

function parseDL(lines: string[], rc: RefCollector): string {
  return `<dl>${lines.map((l) => {
    if (l.startsWith(";")) {
      const c = l.replace(/^;\s*/, "");
      const ci = c.indexOf(":");
      if (ci > 0) return `<dt>${inlineFormat(c.slice(0, ci).trim(), rc)}</dt><dd>${inlineFormat(c.slice(ci + 1).trim(), rc)}</dd>`;
      return `<dt>${inlineFormat(c, rc)}</dt>`;
    }
    return `<dd>${inlineFormat(l.replace(/^:\s*/, ""), rc)}</dd>`;
  }).join("")}</dl>`;
}

function parseTable(lines: string[], rc: RefCollector): string {
  const first = lines[0].replace(/^\{\|\s*/, "").trim();
  const attrs = first ? ` class="wiki-table" ${first}` : ' class="wiki-table"';
  const rows: string[][] = [];
  let cur: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l === "|}") break;
    if (l.startsWith("|-")) { if (cur.length) rows.push(cur); cur = []; continue; }
    if (l.startsWith("!")) { for (const c of l.replace(/^!\s*/, "").split(/\s*!!\s*/)) cur.push(`<th>${inlineFormat(c.trim(), rc)}</th>`); }
    else if (l.startsWith("|")) { for (const c of l.replace(/^\|\s*/, "").split(/\s*\|\|\s*/)) cur.push(`<td>${inlineFormat(c.trim(), rc)}</td>`); }
  }
  if (cur.length) rows.push(cur);
  return `<table${attrs}>${rows.map((r) => `<tr>${r.join("")}</tr>`).join("")}</table>`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}
