import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/**
 * A controlled image field: upload a file (stored as an asset) or paste a URL.
 * The chosen URL is mirrored into a hidden input named `name` so it submits with
 * a plain <Form>. Shows a preview with a Remove button once a value is set.
 */
export function ImageUploadField({
  name,
  value,
  onChange,
  accept = "image/*",
  slug,
}: {
  name: string;
  value: string;
  onChange: (url: string) => void;
  accept?: string;
  /** Store the upload under content/assets/<slug>/ when provided. */
  slug?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (slug) formData.append("slug", slug);
      const res = await fetch("/api/assets/upload", { method: "POST", body: formData });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Upload failed");
      }
      const { url, commitSha } = await res.json();
      onChange(commitSha ? `${url}?ref=${commitSha}` : url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={value} />

      {value && (
        <div className="relative w-full max-w-md overflow-hidden rounded-md border">
          <img src={value} alt="Header preview" className="max-h-48 w-full object-cover" />
          <button
            type="button"
            onClick={() => onChange("")}
            className="absolute right-2 top-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white hover:bg-black/80"
          >
            Remove
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
          {uploading ? "Uploading…" : value ? "Replace image" : "Upload image"}
        </Button>
        <Input
          // Plain text, not type="url": uploaded assets are relative paths
          // (e.g. /api/assets/foo.png) which fail native URL validation.
          type="text"
          placeholder="…or paste an image URL"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-xs"
        />
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
