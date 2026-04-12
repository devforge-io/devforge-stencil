import { listAssets } from "~/lib/github.server";

export async function loader() {
  try {
    const files = await listAssets();
    const assets = files.map((f) => ({
      name: f.name,
      url: `/api/assets/${f.name}`,
      size: f.size,
      commitSha: f.commitSha,
    }));
    return Response.json({ assets });
  } catch {
    return Response.json({ assets: [] });
  }
}
