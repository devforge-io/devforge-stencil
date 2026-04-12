import {
  listWhiteboardFiles,
  getWhiteboardFile,
  saveWhiteboardFile,
  deleteWhiteboardFile,
  uploadAsset,
} from "./github.server";

export interface WhiteboardListItem {
  slug: string;
  sha: string;
  imageUrl: string;
}

export interface Whiteboard {
  pageSlug: string;
  slug: string;
  sha: string;
  scene: unknown;
  imageUrl: string;
}

function slugFromFilename(filename: string): string {
  return filename.replace(/\.excalidraw$/, "");
}

function imageName(pageSlug: string, wbSlug: string): string {
  return `whiteboard-${pageSlug}-${wbSlug}.png`;
}

function imageUrlFor(pageSlug: string, wbSlug: string): string {
  return `/api/assets/${imageName(pageSlug, wbSlug)}`;
}

export async function listWhiteboardsForPage(
  pageSlug: string
): Promise<WhiteboardListItem[]> {
  const files = await listWhiteboardFiles(pageSlug);
  return files.map((f) => {
    const wbSlug = slugFromFilename(f.name);
    return {
      slug: wbSlug,
      sha: f.sha,
      imageUrl: imageUrlFor(pageSlug, wbSlug),
    };
  });
}

export async function getWhiteboard(
  pageSlug: string,
  wbSlug: string
): Promise<Whiteboard | null> {
  const file = await getWhiteboardFile(pageSlug, wbSlug);
  if (!file) return null;

  let scene: unknown;
  try {
    scene = JSON.parse(file.content);
  } catch {
    return null;
  }

  return {
    pageSlug,
    slug: wbSlug,
    sha: file.sha,
    scene,
    imageUrl: imageUrlFor(pageSlug, wbSlug),
  };
}

export async function saveWhiteboard(
  pageSlug: string,
  wbSlug: string,
  scene: unknown,
  imageDataUrl: string | null,
  sha?: string
): Promise<{ sha: string; imageUrl: string }> {
  const sceneJson = JSON.stringify(scene, null, 2);
  const result = await saveWhiteboardFile(pageSlug, wbSlug, sceneJson, sha);

  if (imageDataUrl) {
    const base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
    await uploadAsset(imageName(pageSlug, wbSlug), base64);
  }

  return { sha: result.sha, imageUrl: imageUrlFor(pageSlug, wbSlug) };
}

export async function removeWhiteboard(
  pageSlug: string,
  wbSlug: string,
  sha: string
): Promise<void> {
  await deleteWhiteboardFile(pageSlug, wbSlug, sha);
}
