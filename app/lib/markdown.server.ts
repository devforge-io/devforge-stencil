import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import matter from "gray-matter";
import type { Root, Element } from "hast";
import { visit } from "unist-util-visit";

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "figure"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
    img: [...(defaultSchema.attributes?.img ?? []), "style"],
    figure: ["style"],
  },
};

/**
 * Rehype plugin: parse image title attributes like "width=50% align=right"
 * and wrap the image in a styled <figure> tag.
 *
 * Markdown: ![alt](src "width=50% align=center")
 * Output:   <figure style="text-align:center"><img src="..." alt="..." style="width:50%" /></figure>
 */
function rehypeImageAttrs() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "img" || !node.properties?.title) return;

      const title = String(node.properties.title);
      const attrs = parseImageTitle(title);
      if (!attrs) return;

      // Clear title so it doesn't render as a tooltip
      delete node.properties.title;

      const imgStyles: string[] = [];
      const figStyles: string[] = [];

      if (attrs.width) {
        imgStyles.push(`width:${attrs.width}`);
      }

      if (attrs.align) {
        switch (attrs.align) {
          case "center":
            figStyles.push("text-align:center");
            break;
          case "right":
            figStyles.push("text-align:right");
            break;
          case "left":
            figStyles.push("text-align:left");
            break;
          case "float-left":
            imgStyles.push("float:left", "margin-right:1rem", "margin-bottom:0.5rem");
            break;
          case "float-right":
            imgStyles.push("float:right", "margin-left:1rem", "margin-bottom:0.5rem");
            break;
        }
      }

      if (imgStyles.length > 0) {
        node.properties.style = imgStyles.join(";");
      }

      // Wrap in figure if we have any styling
      if (figStyles.length > 0 || imgStyles.length > 0) {
        const figure: Element = {
          type: "element",
          tagName: "figure",
          properties: figStyles.length > 0 ? { style: figStyles.join(";") } : {},
          children: [node],
        };

        if (parent && typeof index === "number") {
          parent.children[index] = figure;
        }
      }
    });
  };
}

function parseImageTitle(
  title: string
): { width?: string; align?: string } | null {
  const widthMatch = title.match(/width=(\S+)/);
  const alignMatch = title.match(/align=(\S+)/);

  if (!widthMatch && !alignMatch) return null;

  return {
    width: widthMatch?.[1],
    align: alignMatch?.[1],
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeImageAttrs)
  .use(rehypeHighlight, { detect: true })
  .use(rehypeSanitize, sanitizeSchema)
  .use(rehypeStringify);

export interface ContentFrontmatter {
  title: string;
  description?: string;
  tags?: string[];
  publishedAt?: string;
  updatedAt?: string;
  draft?: boolean;
  [key: string]: unknown;
}

export interface ParsedContent {
  frontmatter: ContentFrontmatter;
  html: string;
  raw: string;
}

export async function parseMarkdown(raw: string): Promise<ParsedContent> {
  const { data, content } = matter(raw);

  const result = await processor.process(content);

  return {
    frontmatter: {
      title: data.title ?? "Untitled",
      description: data.description,
      tags: data.tags,
      publishedAt: data.publishedAt,
      updatedAt: data.updatedAt,
      draft: data.draft ?? false,
      ...data,
    },
    html: String(result),
    raw,
  };
}

/**
 * Render markdown body directly to HTML, skipping frontmatter parsing.
 * Use this for previews where the input is body content only.
 */
export async function renderBody(body: string): Promise<string> {
  const result = await processor.process(body);
  return String(result);
}

export function parseFrontmatterOnly(raw: string): ContentFrontmatter {
  const { data } = matter(raw);
  return {
    title: data.title ?? "Untitled",
    description: data.description,
    tags: data.tags,
    publishedAt: data.publishedAt,
    updatedAt: data.updatedAt,
    draft: data.draft ?? false,
    ...data,
  };
}
