/**
 * Pure signal resolvers for the richer Phase 3 context (time windows, geo, and
 * A/B buckets). Each is a deterministic function of its inputs so it can be
 * unit-tested and reused on either side of the wire. No Node-only imports — this
 * module is safe to import from client code (the flow-canvas preview) too.
 */

export interface TimeSignals {
  /** 0–23, UTC. */
  hour: number;
  /** 0–59, UTC. */
  minute: number;
  /** Day of week, 0 = Sunday, UTC. */
  day: number;
  /** Calendar date `YYYY-MM-DD`, UTC. */
  date: string;
  /** Full ISO-8601 timestamp. */
  iso: string;
  /** Epoch milliseconds. */
  ts: number;
}

/** Time-window signals derived (in UTC) from a point in time. */
export function timeSignals(now: Date): TimeSignals {
  return {
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    day: now.getUTCDay(),
    date: now.toISOString().slice(0, 10),
    iso: now.toISOString(),
    ts: now.getTime(),
  };
}

export interface GeoSignals {
  country: string | null;
  region: string | null;
  city: string | null;
}

/**
 * Geo signals from the edge/CDN headers most proxies inject (Cloudflare,
 * Vercel, Fastly, generic). Returns nulls when the platform doesn't provide
 * them. Author conditions like `geo.country is GB`.
 */
export function geoSignals(headers: Headers): GeoSignals {
  const first = (...names: string[]): string | null => {
    for (const n of names) {
      const v = headers.get(n);
      if (v) return decode(v);
    }
    return null;
  };
  return {
    country: first("cf-ipcountry", "x-vercel-ip-country", "x-geo-country", "x-country-code", "fastly-geoip-countrycode"),
    region: first("x-vercel-ip-country-region", "x-geo-region", "cf-region-code"),
    city: first("x-vercel-ip-city", "x-geo-city", "cf-ipcity"),
  };
}

function decode(v: string): string {
  try {
    return decodeURIComponent(v); // Vercel URL-encodes city/region
  } catch {
    return v;
  }
}

export interface AbSignals {
  /** Stable 0–99 bucket for the seed. */
  bucket: number;
  /** Coarse two-way split derived from the bucket. */
  group: "a" | "b";
}

/**
 * Deterministic A/B assignment from a stable seed (a visitor id, an explicit
 * `__stencil_ab` cookie, or an ip+ua fingerprint). Same seed → same bucket, so
 * a visitor sees a consistent variant.
 */
export function abSignals(seed: string): AbSignals {
  const bucket = fnv1a(seed) % 100;
  return { bucket, group: bucket < 50 ? "a" : "b" };
}

/** 32-bit FNV-1a hash — small, fast, dependency-free, stable across runs. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
