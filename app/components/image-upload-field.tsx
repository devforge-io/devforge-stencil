import { useRef, useState } from "react";
import ReactCrop, {
  centerCrop,
  makeAspectCrop,
  type Crop,
  type PixelCrop,
} from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/**
 * A controlled image field: upload a file (stored as an asset) or paste a URL.
 * The chosen URL is mirrored into a hidden input named `name` so it submits with
 * a plain <Form>. Shows a preview with a Remove button once a value is set.
 *
 * When `crop` is provided, a picked file first opens an aspect-locked crop editor
 * and the result is re-encoded to exactly `crop.width`×`crop.height` (e.g.
 * 1200×630 for social images) — fixing both aspect ratio and file size.
 */
export function ImageUploadField({
  name,
  value,
  onChange,
  accept = "image/*",
  slug,
  crop,
}: {
  name: string;
  value: string;
  onChange: (url: string) => void;
  accept?: string;
  /** Store the upload under content/assets/<slug>/ when provided. */
  slug?: string;
  /** Enable an aspect-locked crop/resize step, producing this exact size. */
  crop?: { width: number; height: number };
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Crop editor state (only used when `crop` is set).
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropName, setCropName] = useState("image.jpg");
  const [cropRect, setCropRect] = useState<Crop>();
  const [completedRect, setCompletedRect] = useState<PixelCrop>();
  const imgRef = useRef<HTMLImageElement>(null);
  const aspect = crop ? crop.width / crop.height : undefined;

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

  // Picking a file either opens the crop editor (when `crop` is set) or uploads.
  const onPick = (file: File) => {
    setError(null);
    if (crop) {
      const reader = new FileReader();
      reader.onload = () => {
        setCropName(file.name.replace(/\.\w+$/, "") + ".jpg");
        setCropSrc(reader.result as string);
      };
      reader.readAsDataURL(file);
    } else {
      handleFile(file);
    }
  };

  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (!aspect) return;
    const { width, height } = e.currentTarget;
    setCropRect(
      centerCrop(makeAspectCrop({ unit: "%", width: 90 }, aspect, width, height), width, height)
    );
  };

  const applyCrop = async () => {
    const image = imgRef.current;
    if (!image || !completedRect || !crop) return;
    const scaleX = image.naturalWidth / image.width;
    const scaleY = image.naturalHeight / image.height;
    const canvas = document.createElement("canvas");
    canvas.width = crop.width;
    canvas.height = crop.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      image,
      completedRect.x * scaleX,
      completedRect.y * scaleY,
      completedRect.width * scaleX,
      completedRect.height * scaleY,
      0,
      0,
      crop.width,
      crop.height
    );
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85)
    );
    setCropSrc(null);
    if (blob) await handleFile(new File([blob], cropName, { type: "image/jpeg" }));
  };

  return (
    <div className="space-y-2">
      <input type="hidden" name={name} value={value} />

      {value && (
        <div className="relative w-full max-w-md overflow-hidden rounded-md border">
          <img src={value} alt="Preview" className="max-h-48 w-full object-cover" />
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
          if (f) onPick(f);
          e.target.value = "";
        }}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* Crop editor */}
      {cropSrc && crop && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 rounded-lg bg-white p-4 dark:bg-gray-900">
            <div>
              <h2 className="text-sm font-semibold">Crop image</h2>
              <p className="text-xs text-muted-foreground">
                Locked to {crop.width}×{crop.height} ({(crop.width / crop.height).toFixed(2)}:1). Drag to adjust.
              </p>
            </div>
            <div className="flex-1 overflow-auto">
              <ReactCrop
                crop={cropRect}
                onChange={(c) => setCropRect(c)}
                onComplete={(c) => setCompletedRect(c)}
                aspect={aspect}
                keepSelection
              >
                <img
                  ref={imgRef}
                  src={cropSrc}
                  alt="To crop"
                  onLoad={onImageLoad}
                  style={{ maxHeight: "60vh", width: "auto" }}
                />
              </ReactCrop>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setCropSrc(null)}>
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={!completedRect?.width} onClick={applyCrop}>
                Apply &amp; upload
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
