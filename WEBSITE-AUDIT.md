# Website audit: extended service and port scanning

Status: **plan, not built yet.** This document is the design for adding open-port
discovery, service and version fingerprinting, and known-issue reporting to the
existing `/tools/website-audit`. Nothing here is wired up; it is the shape to
build to and the decisions Ben needs to make first.

Written to match the current audit engine (`app/lib/audit/`), which already does
non-intrusive reconnaissance (TLS handshake, exposed-path probes, DNS, RDAP,
HTTP methods, source maps). This extends that engine along the same grain rather
than bolting on a separate scanner.

Style note for this repo: no em dashes.

## 1. Goals and non-goals

### Goals

- **Open ports.** For the target host, find which TCP ports accept a connection,
  from a curated, web-relevant port list (not a full 1-65535 sweep).
- **Service and version.** For each open port, name the service and, where the
  service volunteers it, its product and version (for example
  `OpenSSH_9.6p1`, `nginx/1.24.0`, `Postfix`). Passive banner reading and
  lightweight protocol greetings only.
- **Security issues.** Turn those facts into findings: services that should not
  be publicly reachable at all (databases, admin ports), weak or legacy
  transport on a port, end-of-life or known-vulnerable product versions, and
  configuration tells that leak in a banner.

### Non-goals (do not build these)

- **No exploitation.** The tool reports "this version has known CVEs, verify and
  patch"; it never proves the vulnerability by triggering it. No payloads, no
  fuzzing, no auth guessing, no writes to any service.
- **No intrusive scanning.** No SYN/stealth scanning (needs raw sockets and root
  we do not have), no UDP sweep, no full port range by default, no subdomain
  brute force, no traffic amplification.
- **No third-party dragnet.** This is an audit-your-own-site tool. Section 2 is
  about keeping it that way. Scanning hosts the operator does not control is the
  abuse case, and the default posture must discourage it.

## 2. Authorization, safety and abuse (decide this first)

Port scanning a host you do not own is legally grey in many places and breaches
the acceptable-use policy of most hosting and cloud providers. The current audit
only makes ordinary HTTP reads of public pages, which is uncontroversial; port
and service scanning is a different risk class and needs a posture decision
**before any code lands**. Options, cheapest to strictest:

1. **Non-intrusive default, no gate.** Keep the port list short and universally
   benign (the ports a normal web host already exposes: 80, 443, 8080, 8443, and
   a read of their banners), no databases or admin ports probed unless the caller
   proves control. Low abuse value, low friction. This is the safe default and
   what an MVP should ship.
2. **Ownership-gated deep scan.** The extended port list and version-to-CVE
   reporting only run against a domain the user has verified they control:
   a DNS TXT token (`devforge-audit=<nonce>`) or a file at
   `/.well-known/devforge-audit-<nonce>` the loader checks before scanning. This
   is the honest answer for a real product feature and the recommended target
   state. It also lets rate limits be per-verified-domain rather than per-IP.
3. **Account-gated.** Same as (2) but tied to a signed-in account so abuse is
   attributable and revocable.

Regardless of which gate is chosen, these are non-negotiable:

- **The SSRF guard must run at the socket layer, not just the URL layer.** The
  existing `assertPublicHttpUrl` (`fetch.server.ts:280`) resolves the host and
  rejects private, loopback, link-local and reserved addresses. Port scanning
  connects to a host:port, not a URL, so it needs the same check and one more
  thing the HTTP path gets for free: **pin the resolved public IP and connect to
  that IP**, so a DNS rebind between "resolve, looked public" and "connect"
  cannot land us on `169.254.169.254` or a private host. Reuse
  `isPrivateAddress` / `isPrivateIpv4` / `isPrivateIpv6` (`fetch.server.ts:203`).
  Never connect to a hostname you have not just resolved and vetted.
- **Blocklist the metadata and internal ranges explicitly**, on top of the
  private-range check: cloud metadata IPs, and the operator's own
  infrastructure.
- **Hard budgets and low concurrency**, same as the existing recon session: a
  per-port connect timeout, a bounded number of concurrent sockets, a total time
  budget, and a hard ceiling on ports per scan. See section 5.
- **Rate limiting that actually holds.** The route's current limiter
  (`route.tsx:69`, 8/min) is in-memory and per-instance, fine for HTTP reads.
  A scanner needs a shared-store limit (per source IP, per target host, and a
  global cap), because a scan is heavier and more abusable than a page read, and
  the container may run more than one instance.
- **Abuse logging.** Record who scanned what and when, so misuse is visible.

Recommendation: ship MVP as posture (1); design the data model and job runner so
posture (2) can be switched on without reshaping anything.

## 3. How it fits the existing architecture

The audit pipeline is: `fetchPageContext` (`fetch.server.ts`) gathers everything
into a server-only `PageContext`; each check module in `checks/*.server.ts`
(signature `CheckFn = (ctx) => Finding[]`, `types.ts`) turns that context into
findings; `audit.server.ts` runs every check, scores each category and folds the
lot into a serialisable `AuditReport`. The new work slots into all three layers
without changing the contract:

1. **Recon (new).** A `scanPorts(...)` stage in a new module
   `app/lib/audit/scan.server.ts` (keep it out of the already large
   `fetch.server.ts`). It produces a `PortScan` structure and hangs it off
   `PageContext`. Runs inside the same recon session and budget as the other
   sidecar probes, or as a separate job (section 11).
2. **Types.** New interfaces in `types.ts` (`PortScan`, `OpenPort`,
   `ServiceBanner`, `VersionFinding`), a new `CategoryId` (`"ports"`), and the
   `CATEGORY_META` / `CATEGORY_ORDER` entries. `types.ts` is client-safe, so no
   server imports; the scan runner is `*.server.ts`.
3. **Check module (new).** `checks/ports.server.ts` reads `ctx.portScan` and
   emits findings: open-port inventory, exposed-service warnings,
   version/CVE issues. Register it in the `CHECKS` array in `audit.server.ts:39`.
   Because scoring is credit-based per category (`categoryScore`,
   `audit.server.ts`), a category that produced no findings (scan skipped or
   nothing open) is simply excluded from the overall score, which is the
   behaviour we want when the scan did not run.

No existing check changes. The scoring, PDF and report layers pick up the new
category generically, with the exception of any bespoke rendering we choose to
add for the port table (section 10).

## 4. Stage 1: port discovery

**Method: TCP connect scan** via `node:net` `createConnection`. This is the only
method available to us: SYN scanning needs raw sockets and elevated privilege we
will not have in the container, and serverless has neither. A connect scan
completes the TCP handshake and immediately closes; it is observable in the
target's logs, which is correct and honest for an audit tool.

**Port list, not port range.** A default focused list of high-signal ports, not
a sweep. Two tiers:

- **Default (non-intrusive):** the web surface only. `80, 443, 8080, 8443, 8000,
  3000`. Safe to run against anyone, low abuse value.
- **Extended (ownership-gated, section 2):** add the ports whose mere exposure is
  a finding: `21` ftp, `22` ssh, `23` telnet, `25/465/587` smtp, `110/143/993/995`
  mail retrieval, `3306` mysql, `5432` postgres, `6379` redis, `27017` mongodb,
  `9200` elasticsearch, `11211` memcached, `3389` rdp, `5900` vnc, `2375/2376`
  docker, `9000` various admin, `8888`, `1433` mssql. This is the "you left the
  database open" list.

Keep the list as a named constant so it is auditable and tunable, the same way
`DKIM_SELECTORS` and the exposed-path list already are.

**Per-port classification** from the connect attempt:

- `open`: handshake completed.
- `closed`: connection refused (RST).
- `filtered`: timed out with no response (firewall dropping packets).

**Budgets** (mirror the recon session, `fetch.server.ts:65-72`):

- Per-port connect timeout: 2 s (`filtered` verdict on timeout).
- Concurrency: cap around 10-20 sockets in flight (`mapWithLimit`,
  `fetch.server.ts:1172`). Higher than recon's 5 because these are cheap
  connects, but still bounded so we are not a scanner someone points at a victim.
- Total scan budget: a hard wall (for example 20 s) after which we report what we
  have and mark the scan `partial`. The default 6-port list finishes in well
  under this; the extended list of ~25 ports at concurrency 15 fits comfortably.
- Hard ceiling on ports per scan, enforced in code, so a future config typo
  cannot turn this into a range sweep.

## 5. Stage 2: service and version detection

Passive, best-effort, one light touch per open port. For each open port, in
order of cheapest signal:

1. **Read the greeting.** Many services speak first: SSH sends
   `SSH-2.0-OpenSSH_9.6p1 Ubuntu-...`, SMTP/FTP/IMAP/POP send a banner line on
   connect. Read up to a small cap (say 1 KB) with a short read timeout, then
   close. No commands sent. This alone yields product and version for the noisy
   services.
2. **HTTP(S) on the port.** For a port that looks like HTTP, send one `HEAD /`
   (or `GET /` with a byte cap) and read `Server`, `X-Powered-By`,
   `X-AspNet-Version` and the HTTP version. This reuses the header-capture the
   main audit already does for the page; factor that out so the port scanner and
   the page fetch share it. For a TLS port, run the existing
   `inspectTlsSocket` (`fetch.server.ts:1219`) to get the certificate, negotiated
   protocol and ALPN, which also tells us http/1.1 vs h2.
3. **Map port to expected service** as a fallback label when nothing is
   volunteered (`3306` -> MySQL, unknown version). Clearly mark these as
   "by port convention" rather than confirmed.

Store, per open port: raw banner (redacted of anything secret-looking, same
discipline as `ExposedPathProbe.excerpt`), parsed `product`, parsed `version`,
and the detection method (`banner` | `http-header` | `tls` | `port-convention`).
Version parsing is a small set of well-known banner regexes; keep them in a
table and treat a non-match as "unknown version", never a guess.

Explicitly not done here: sending service-specific commands beyond the opening
exchange, TLS to plaintext protocols to force errors, or anything that writes.
The line is "read what the service says when you say hello", nothing further.

## 6. Stage 3: turning facts into security issues

Three tiers of finding, in descending confidence:

1. **Exposure by default (high confidence, no version needed).** An open port
   that should not face the public internet is a finding on its own:
   a reachable database (`3306/5432/6379/27017/9200/11211/1433`), remote
   access (`3389/5900/23`), a container daemon (`2375/2376`), an admin port. These
   are `critical` or `warning` regardless of version and need no external data.
   This is the highest-signal, safest output and should be the first thing built.
2. **Transport and config tells (high confidence).** Legacy or plaintext
   protocol on a port (telnet at all; FTP without FTPS; TLS 1.0/1.1, which the
   existing `tls` category already models and can be reused per-port); a banner
   that leaks a full version string or internal hostname; an HTTP service missing
   the security headers the `security` category checks. No CVE database needed.
3. **Known-vulnerable versions (advisory, lower confidence).** Map detected
   `product + version` to known issues. This is the part that needs a data
   source, and the honest framing is advisory: "OpenSSH 8.5 is affected by
   published CVEs and is end-of-life, upgrade", not "you are exploitable". Data
   source options:
   - **Curated local ruleset (recommended for v1).** A small, hand-maintained
     JSON of high-signal rules: end-of-life products, versions below a known-bad
     threshold, defaults that are dangerous. No network dependency, no rate
     limit, fully deterministic and testable, and it covers the common cases
     (old OpenSSH/nginx/Apache/Exim, exposed default configs) without pretending
     to be a full scanner. Ships in the repo, reviewed like code.
   - **OSV.dev / NVD enrichment (later, optional, behind a flag).** For real
     CVE breadth, query a vulnerability API by product/version at scan time,
     with a server-side cache and a strict timeout, and degrade to the curated
     ruleset when it is slow or down. This adds egress, freshness and rate-limit
     concerns; treat it as a phase-2 enhancement, not the MVP. Whatever the
     source, results are always "known issues to verify", never a pass/fail
     exploit claim.

## 7. Data model (types.ts)

Additions, client-safe (no server imports):

```ts
export type PortState = "open" | "closed" | "filtered";
export type ServiceDetection = "banner" | "http-header" | "tls" | "port-convention";

export interface OpenPort {
  port: number;
  transport: "tcp";
  state: PortState;
  service: string | null;        // "ssh", "http", "mysql", ...
  product: string | null;        // "OpenSSH", "nginx", ...
  version: string | null;        // "9.6p1", "1.24.0", ...
  detection: ServiceDetection;
  banner: string | null;         // redacted excerpt, capped
  tls: TlsInfo | null;           // when the port speaks TLS
  secure: boolean;               // transport is encrypted
}

export interface PortScan {
  host: string;
  ip: string;                    // the pinned, vetted public IP we scanned
  scannedAt: string;
  profile: "default" | "extended";
  portsProbed: number;
  open: OpenPort[];
  partial: boolean;              // budget hit before finishing
  skippedReason: string | null;  // gate not satisfied, target is an IP literal, etc.
}
```

Then `PageContext` gains `portScan: PortScan | null` (null when the scan did not
run, exactly like the other best-effort recon fields), and `CategoryId` gains
`"ports"` with matching `CATEGORY_META` and `CATEGORY_ORDER` entries. Nothing in
`AuditReport` changes shape; the new category flows through the existing
serialisation.

## 8. Scoring and category

Add category `ports`, label something like "Open ports & services", a moderate
weight (start near the `exposure` weight of 1.4, since an open database is
comparable to a leaked config file). The existing credit model handles it: an
open database is a `critical` finding (credit 0), a benign open web port with a
tidy banner is a `pass` or `info`. When the scan is skipped the category
produces no findings and `overallScore` (`audit.server.ts`) already excludes
empty categories, so a skipped scan neither helps nor hurts the grade.

## 9. UI and report

- `components/tools/audit/` renders categories generically, so the findings show
  up with no UI work. Worth adding, though: a small **ports table** in the report
  (port, service, product/version, TLS, state) as a bespoke panel, the way the
  preview cards are bespoke, because a table reads far better than a list of
  findings for this data.
- The PDF report (`pdf.server.ts`) is hand-built; the port table needs a
  matching section there if we want it in the PDF. Scope this explicitly; it is
  the one place the new category is not free.
- Surface the scan posture in the UI: which profile ran, whether it was gated,
  and a plain-language "this scanned your own site from our servers" note so the
  output is not mistaken for something run from the visitor's network.

## 10. Deployment and execution model (the load-bearing decision)

The fork runs two ways: a long-running Node container (`Dockerfile`) and Vercel
(the build notes in the root `CLAUDE.md`, `vercel.json`). This matters more than
anything else in this document:

- **Vercel serverless is the wrong place for a port scan.** Functions have a
  short max duration and constrained, sometimes blocked, arbitrary outbound TCP.
  The main audit already lives close to a 15 s total budget; a scan on top does
  not fit a single serverless invocation, and raw connects to arbitrary ports may
  not be permitted at all.
- **The container can do this; serverless should not.** Two workable models:
  1. **Gate by environment.** Run the port scan only when the code detects it is
     on the container runtime, and skip it (with `skippedReason`) on serverless.
     The rest of the audit is unchanged. Simplest, ships first.
  2. **Async job (recommended target).** The scan is too slow and too abusable to
     sit inline in a request/response anyway. Model it as: the action kicks off a
     scan job, returns immediately with a job id, and the client polls a resource
     route for progress and results. This decouples scan duration from HTTP
     timeouts, gives a natural place to enforce the shared-store rate limit and
     the ownership gate, and makes a progress UI possible. It is more work than
     model (1) but it is the honest shape for this feature.

Recommendation: build the engine and check module first behind model (1) so the
capability is real and testable, then move it onto the job runner (2) before it
is exposed to anyone but us.

## 11. Config and environment

- Feature flag: `AUDIT_PORT_SCAN=on|off` (default off until section 2 is
  decided), plus the runtime detection for container-vs-serverless.
- Tunables as named constants alongside the existing ones: port lists, per-port
  timeout, concurrency, total budget, port ceiling.
- Shared-store rate-limit backend for the deeper scan (the in-memory limiter is
  not enough here). Reuse whatever the feature-requests tool already uses for
  state if that fits, rather than adding a new dependency.
- If OSV/NVD enrichment (section 6) is built, its endpoint and any key go in
  `.env`, never committed, and it must degrade cleanly when absent.

## 12. Testing

- Unit-test the banner parsers against captured real banners (OpenSSH, nginx,
  Postfix, vsftpd, Redis) plus junk input, asserting "unknown version" on
  non-matches rather than a guess.
- Unit-test `checks/ports.server.ts` against hand-built `PortScan` fixtures: an
  open database yields a critical, a tidy web port yields a pass, an EOL version
  yields the advisory finding.
- **SSRF/rebind tests are mandatory**, matching the rigour of the existing guard:
  assert that a host resolving to a private or metadata IP is refused, and that
  the scanner connects to the pinned IP and not by re-resolving the hostname.
- Keep it off the network in CI: the connect layer behind a small interface so
  tests inject a fake dialer, the way the recon session is structured. Do not add
  a test that scans a real host.

## 13. Phasing

1. **v1 (safe, useful, small):** default web-port profile only, banner and
   HTTP/TLS version detection, tier-1 and tier-2 findings (exposure-by-default,
   transport tells), curated local ruleset for the obvious EOL cases, run on the
   container behind the feature flag, generic category rendering. No external
   CVE calls, no ownership gate needed because the default profile is benign.
2. **v2:** ownership verification gate (section 2, option 2), the extended
   port profile it unlocks, the async job runner and progress UI, shared-store
   rate limiting, the bespoke ports table in the web and PDF reports.
3. **v3 (optional):** OSV/NVD enrichment with caching for real CVE breadth,
   still framed as advisory.

## 14. Open decisions for Ben

- **Authorization posture (section 2):** ship the benign default only, or invest
  in the ownership-gated deep scan now. This gates how much of section 4's
  extended port list we can responsibly expose.
- **CVE data source (section 6):** curated local ruleset only, or wire up
  OSV/NVD. Affects breadth, freshness, and whether we take on an external
  dependency.
- **Execution model (section 10):** environment-gated inline scan for a fast
  first cut, or go straight to the async job runner.
- **Scope of "security issues":** confirm the hard line at reporting only
  (no exploitation, no active verification), which this plan assumes throughout.
