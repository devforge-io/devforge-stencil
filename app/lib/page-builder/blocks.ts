import type { PBBlock } from "./types";

export const DEFAULT_BLOCKS: PBBlock[] = [
  // Layout
  {
    id: "row",
    label: "Row",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="8" width="20" height="8" rx="1"/><line x1="9" y1="8" x2="9" y2="16"/><line x1="15" y1="8" x2="15" y2="16"/></svg>`,
    content: `<div data-pb-name="Row" class="flex flex-row"></div>`,
  },
  {
    id: "column",
    label: "Column",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="2" width="12" height="20" rx="1"/><line x1="6" y1="9" x2="18" y2="9"/><line x1="6" y1="15" x2="18" y2="15"/></svg>`,
    content: `<div data-pb-name="Column" data-pb-parent="Row" class="flex-1"></div>`,
  },
  {
    id: "section",
    label: "Section",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/></svg>`,
    content: `<section data-pb-name="Section" class="py-12 px-8"><h2 data-pb-name="Heading" class="text-2xl font-bold mb-4 dark:text-white">Section Title</h2><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Section content goes here.</p></section>`,
  },
  {
    id: "hero",
    label: "Hero",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="6" y1="13" x2="18" y2="13"/><rect x="9" y="16" width="6" height="2" rx="1"/></svg>`,
    content: `<section data-pb-name="Hero" class="py-16 px-8 text-center bg-gray-50 dark:bg-gray-900"><h1 data-pb-name="Heading" class="text-4xl font-bold mb-4 dark:text-white">Hero Title</h1><p data-pb-name="Text" class="text-lg text-gray-500 dark:text-gray-400 max-w-xl mx-auto mb-8">A compelling description that draws readers in.</p><a data-pb-name="Button" href="#" class="inline-flex items-center gap-2 px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium no-underline"><span data-pb-name="Label">Get Started</span></a></section>`,
  },
  {
    id: "two-cols",
    label: "2 Columns",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="9" height="16" rx="1"/><rect x="13" y="4" width="9" height="16" rx="1"/></svg>`,
    content: `<div data-pb-name="2 Columns" class="flex gap-8 p-8"><div data-pb-name="Column" class="flex-1"><h3 data-pb-name="Heading" class="text-xl font-semibold mb-2 dark:text-white">Column 1</h3><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Content here.</p></div><div data-pb-name="Column" class="flex-1"><h3 data-pb-name="Heading" class="text-xl font-semibold mb-2 dark:text-white">Column 2</h3><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Content here.</p></div></div>`,
  },
  {
    id: "three-cols",
    label: "3 Columns",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="4" width="6" height="16" rx="1"/><rect x="9" y="4" width="6" height="16" rx="1"/><rect x="17" y="4" width="6" height="16" rx="1"/></svg>`,
    content: `<div data-pb-name="3 Columns" class="flex gap-8 p-8"><div data-pb-name="Column" class="flex-1"><h3 data-pb-name="Heading" class="text-xl font-semibold mb-2 dark:text-white">Col 1</h3><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Content.</p></div><div data-pb-name="Column" class="flex-1"><h3 data-pb-name="Heading" class="text-xl font-semibold mb-2 dark:text-white">Col 2</h3><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Content.</p></div><div data-pb-name="Column" class="flex-1"><h3 data-pb-name="Heading" class="text-xl font-semibold mb-2 dark:text-white">Col 3</h3><p data-pb-name="Text" class="text-gray-600 dark:text-gray-400">Content.</p></div></div>`,
  },
  {
    id: "nav",
    label: "Navbar",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="4" rx="1"/><line x1="6" y1="6" x2="10" y2="6"/><line x1="14" y1="6" x2="18" y2="6"/></svg>`,
    content: `<nav data-pb-name="Navbar" class="flex items-center justify-between px-8 py-4 border-b border-gray-200 dark:border-gray-800"><span data-pb-name="Brand" class="text-xl font-bold dark:text-white">Brand</span><div data-pb-name="Nav Links" class="flex items-center gap-6"><a data-pb-name="Link" href="#" class="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white no-underline text-sm">Features</a><a data-pb-name="Link" href="#" class="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white no-underline text-sm">Pricing</a><a data-pb-name="Link" href="#" class="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white no-underline text-sm">About</a><a data-pb-name="Button" href="#" class="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm no-underline"><span data-pb-name="Label">Sign Up</span></a></div></nav>`,
  },
  {
    id: "footer",
    label: "Footer",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="16" width="20" height="4" rx="1"/><line x1="6" y1="18" x2="18" y2="18"/></svg>`,
    content: `<footer data-pb-name="Footer" class="bg-gray-900 dark:bg-gray-950 text-gray-400 py-12 px-8"><div data-pb-name="Row" class="flex gap-12 mb-8"><div data-pb-name="Column"><h4 data-pb-name="Heading" class="text-white font-semibold mb-3 text-sm">Product</h4><ul data-pb-name="List" class="space-y-2 text-sm list-none p-0"><li><a data-pb-name="Link" href="#" class="text-gray-400 hover:text-white no-underline">Features</a></li><li><a data-pb-name="Link" href="#" class="text-gray-400 hover:text-white no-underline">Pricing</a></li></ul></div><div data-pb-name="Column"><h4 data-pb-name="Heading" class="text-white font-semibold mb-3 text-sm">Company</h4><ul data-pb-name="List" class="space-y-2 text-sm list-none p-0"><li><a data-pb-name="Link" href="#" class="text-gray-400 hover:text-white no-underline">About</a></li><li><a data-pb-name="Link" href="#" class="text-gray-400 hover:text-white no-underline">Contact</a></li></ul></div></div><p data-pb-name="Text" class="text-sm border-t border-gray-800 pt-6">Made with Stencil CMS</p></footer>`,
  },
  {
    id: "container",
    label: "Container",
    category: "Layout",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="4 2"/></svg>`,
    content: `<div data-pb-name="Container" class="max-w-4xl mx-auto px-4"></div>`,
  },

  // Basic
  {
    id: "heading",
    label: "Heading",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 12h12M4 18h8"/></svg>`,
    content: `<h2 data-pb-name="Heading" class="text-2xl font-bold dark:text-white">Heading</h2>`,
  },
  {
    id: "paragraph",
    label: "Paragraph",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 6h16M4 10h16M4 14h12M4 18h8"/></svg>`,
    content: `<p data-pb-name="Text" class="text-base text-gray-600 dark:text-gray-400">Insert your text here.</p>`,
  },
  {
    id: "link",
    label: "Link",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>`,
    content: `<a data-pb-name="Link" href="#" class="text-indigo-500 dark:text-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-300 underline">Link text</a>`,
  },
  {
    id: "image",
    label: "Image",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`,
    content: `<img data-pb-name="Image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='250' fill='%23e5e7eb'%3E%3Crect width='400' height='250'/%3E%3Ctext x='50%25' y='50%25' font-family='sans-serif' font-size='16' fill='%239ca3af' text-anchor='middle' dy='.3em'%3EImage%3C/text%3E%3C/svg%3E" alt="placeholder" class="w-full rounded-lg" />`,
  },
  {
    id: "button",
    label: "Button",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="8" width="18" height="8" rx="4"/></svg>`,
    content: `<a data-pb-name="Button" href="#" class="inline-flex items-center gap-2 px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium no-underline"><span data-pb-name="Label">Button</span></a>`,
  },
  {
    id: "divider",
    label: "Divider",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="12" x2="22" y2="12"/></svg>`,
    content: `<hr data-pb-name="Divider" class="border-t border-gray-200 dark:border-gray-700 my-8" />`,
  },
  {
    id: "spacer",
    label: "Spacer",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="12" y1="4" x2="12" y2="20" stroke-dasharray="2 2"/><line x1="4" y1="4" x2="20" y2="4"/><line x1="4" y1="20" x2="20" y2="20"/></svg>`,
    content: `<div data-pb-name="Spacer" class="h-12"></div>`,
  },
  {
    id: "video",
    label: "Video",
    category: "Basic",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10,8 16,12 10,16" fill="currentColor"/></svg>`,
    content: `<div data-pb-name="Video" class="aspect-video bg-gray-900 dark:bg-gray-800 rounded-lg flex items-center justify-center"><span class="text-gray-500 dark:text-gray-400">Video Embed</span></div>`,
  },

  // Components
  {
    id: "card",
    label: "Card",
    category: "Components",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
    content: `<div data-pb-name="Card" class="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden max-w-sm bg-white dark:bg-gray-800"><div data-pb-name="Card Image" class="h-44 bg-gray-100 dark:bg-gray-700"></div><div data-pb-name="Card Body" class="p-5"><h3 data-pb-name="Heading" class="font-semibold mb-2 dark:text-white">Card Title</h3><p data-pb-name="Text" class="text-gray-500 dark:text-gray-400 text-sm">Card description goes here.</p></div></div>`,
  },
  {
    id: "testimonial",
    label: "Testimonial",
    category: "Components",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M7.5 8.5h-4a1 1 0 00-1 1v4a1 1 0 001 1h2l-1 3 3-3h0a1 1 0 001-1v-4a1 1 0 00-1-1z"/></svg>`,
    content: `<div data-pb-name="Testimonial" class="bg-gray-50 dark:bg-gray-800 rounded-xl p-8 max-w-lg mx-auto text-center"><p data-pb-name="Quote" class="text-gray-600 dark:text-gray-300 italic mb-4">"This is an amazing product that changed how we work."</p><p data-pb-name="Author" class="font-semibold text-sm dark:text-white">Jane Doe</p><p data-pb-name="Role" class="text-gray-400 text-xs">CEO, Company</p></div>`,
  },
  {
    id: "pricing",
    label: "Pricing Card",
    category: "Components",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="4" y1="9" x2="20" y2="9"/></svg>`,
    content: `<div data-pb-name="Pricing Card" class="border border-gray-200 dark:border-gray-700 rounded-xl p-8 max-w-xs text-center bg-white dark:bg-gray-800"><h3 data-pb-name="Plan Name" class="text-lg font-semibold mb-1 dark:text-white">Pro Plan</h3><p data-pb-name="Description" class="text-gray-400 text-sm mb-4">For growing teams</p><p data-pb-name="Price" class="text-4xl font-bold mb-6 dark:text-white">$49<span class="text-base font-normal text-gray-400">/mo</span></p><ul data-pb-name="Features" class="text-sm text-gray-600 dark:text-gray-400 space-y-2 mb-8 text-left list-none p-0"><li>Unlimited projects</li><li>Priority support</li><li>Advanced analytics</li></ul><a data-pb-name="Button" href="#" class="flex items-center justify-center gap-2 w-full py-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium no-underline text-center"><span data-pb-name="Label">Get Started</span></a></div>`,
  },
];
