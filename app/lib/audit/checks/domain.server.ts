/**
 * Domain registration checks, from RDAP.
 *
 * Everything here is derived from `ctx.rdap` - the registry's own record of the
 * domain - plus two cross-references against what the rest of the audit already
 * observed (`ctx.dns.ns` and `ctx.tls`). Nothing in this module makes a network
 * call of its own.
 *
 * This is the layer underneath every other category. TLS, DNS, mail
 * authentication and the site itself all assume the registration is intact: a
 * domain that lapses takes down the website, the mail, every OAuth callback and
 * every webhook at the same instant, and once it has been released anyone may
 * register it and receive the password-reset mail. The registration is also the
 * thing nobody monitors, because it renews silently for years and then does not.
 *
 * Two accuracy rules govern this module:
 *
 *   1. Never assert something the RDAP response cannot show. Registries vary
 *      enormously in what they publish - many redact contacts entirely, some
 *      omit nameservers, some omit `secureDNS` - and an absent field means "not
 *      reported", never "not configured". Where a field is missing, say that.
 *   2. Status codes are matched defensively. RDAP returns EPP statuses in the
 *      space-separated human form ("client transfer prohibited"); WHOIS and some
 *      registries return the camelCase token ("clientTransferProhibited"). Both
 *      are normalised to the same key before comparison, so neither spelling can
 *      silently disable a check.
 */

import type { Finding, PageContext, RdapInfo } from "~/lib/audit/types";

/* -------------------------------------------------------------------------- */
/* Reference material                                                          */
/* -------------------------------------------------------------------------- */

const EPP_STATUS_CODES = "https://www.icann.org/resources/pages/epp-status-codes-2014-06-16-en";
const RFC_RDAP_RESPONSES = "https://www.rfc-editor.org/rfc/rfc9083";
const RFC_RDAP_BOOTSTRAP = "https://www.rfc-editor.org/rfc/rfc7484";
const ICANN_ERRP = "https://www.icann.org/resources/pages/errp-2013-02-28-en";
const ICANN_TRANSFER_POLICY = "https://www.icann.org/resources/pages/transfer-policy-2016-06-01-en";
const ICANN_DNSSEC = "https://www.icann.org/resources/pages/dnssec-what-is-it-why-important-2019-03-05-en";
const ICANN_LOOKUP = "https://lookup.icann.org/";
const DNSVIZ = "https://dnsviz.net/";

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Non-empty trimmed string, or null. Never returns "undefined" as text. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A finite number or null - guards every arithmetic path against NaN. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse an ISO timestamp, returning null for anything unusable. */
function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole days from `a` to `b`; negative when `b` is in the past. */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** `2026-08-17` - stable, unambiguous, and never NaN because the input parsed. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Join a list for prose, capping the visible entries. */
function listOf(items: string[], max = 8): string {
  if (items.length === 0) return "none";
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")}, and ${items.length - max} more`;
}

/** Days rendered as a rough human span, for prose that reads badly in raw days. */
function humanSpan(days: number): string {
  const abs = Math.abs(days);
  if (abs < 60) return pluralise(abs, "day");
  if (abs < 730) return `${Math.round(abs / 30.44)} months`;
  return `${(abs / 365.25).toFixed(1)} years`;
}

/** Lowercased, dot-stripped hostname for comparing nameservers. */
function normaliseHost(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase();
}

/**
 * Collapse an EPP status into a comparison key.
 *
 * RDAP serves `"client transfer prohibited"`; EPP itself, WHOIS text and some
 * registry RDAP implementations serve `"clientTransferProhibited"`. Stripping
 * everything that is not a letter and lowercasing maps both onto
 * `clienttransferprohibited`, so a check written against one spelling cannot be
 * defeated by the other.
 */
function statusKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

/* -------------------------------------------------------------------------- */
/* Main entry point                                                            */
/* -------------------------------------------------------------------------- */

export function domainChecks(ctx: PageContext): Finding[] {
  const findings: Finding[] = [];
  const rdap: RdapInfo | null = ctx.rdap;

  /** The registrable name, for prose. Falls back to the host we actually fetched. */
  const domain = domainLabel(ctx);

  /* ---------------------------------------------------------------------- */
  /* 0. Nothing to look at                                                   */
  /* ---------------------------------------------------------------------- */

  if (rdap === null) {
    findings.push({
      id: "dom-rdap-unavailable",
      category: "domain",
      severity: "info",
      title: "Registration data could not be retrieved",
      detail:
        `No RDAP response was obtained for ${domain}, so nothing in this section was evaluated. This is a limitation of the scan, not a finding about the domain. The usual reasons are benign: a good number of country-code registries operate no RDAP service at all - RDAP is only mandatory for gTLDs, and several ccTLDs still publish registration data by port-43 WHOIS or a web form only - and IP literals and hosts that cannot be reduced to a registrable domain have no registration to look up in the first place. A rate limit or a timeout produces the same silence. Read this category as unmeasured: expiry, transfer locks and DNSSEC delegation are all unknown rather than absent.`,
      fix: `Check the registration by hand. ICANN Lookup covers every gTLD and reports the same registry data RDAP would have returned; for a ccTLD without RDAP, the registry's own WHOIS page is authoritative. Whatever the answer, confirm the expiry date and that auto-renew is on - that is the fact this section exists to surface.`,
      snippet: [
        `# the RDAP bootstrap will redirect to whichever registry serves the TLD`,
        `curl -sL https://rdap.org/domain/${domain}`,
        "",
        `# no RDAP service for this TLD? fall back to WHOIS`,
        `whois ${domain}`,
        "",
        `# or look it up in a browser: ${ICANN_LOOKUP}`,
      ].join("\n"),
      docs: RFC_RDAP_BOOTSTRAP,
      weight: 1,
    });
    return findings;
  }

  const now = new Date();

  /* --- normalised facts, computed once ---------------------------------- */

  const registrar = text(rdap.registrar);
  const registrarPhrase = registrar === null ? "your registrar" : registrar;

  const expiresAt = parseIso(rdap.expires);
  const registeredAt = parseIso(rdap.registered);
  const changedAt = parseIso(rdap.lastChanged);

  const daysToExpiry =
    finiteOrNull(rdap.daysUntilExpiry) ?? (expiresAt === null ? null : daysBetween(now, expiresAt));
  const ageDays =
    finiteOrNull(rdap.ageDays) ?? (registeredAt === null ? null : daysBetween(registeredAt, now));
  const daysSinceChange = changedAt === null ? null : daysBetween(changedAt, now);

  /** "on 2027-08-08", or an honest stand-in when the registry omitted the date. */
  const expiresOn =
    expiresAt === null ? "on a date the RDAP response did not include" : `on ${formatDate(expiresAt)}`;
  const expiryValue =
    expiresAt === null
      ? daysToExpiry === null
        ? "expiry not reported"
        : `${daysToExpiry} days remaining`
      : daysToExpiry === null
        ? `expires ${formatDate(expiresAt)}`
        : `expires ${formatDate(expiresAt)} (${daysToExpiry} days)`;
  const registrarValue = registrar === null ? "" : ` · registrar: ${registrar}`;

  const statuses = Array.isArray(rdap.statuses)
    ? rdap.statuses.filter((s): s is string => typeof s === "string" && s.trim() !== "")
    : [];
  const statusKeys = new Set(statuses.map(statusKey));
  const hasStatus = (code: string): boolean => {
    if (statusKeys.has(code)) return true;
    for (const key of statusKeys) {
      if (key.includes(code)) return true;
    }
    return false;
  };

  const registryNs = Array.isArray(rdap.nameservers)
    ? Array.from(new Set(rdap.nameservers.map(normaliseHost).filter((h) => h !== ""))).sort()
    : [];
  const liveNs = Array.from(
    new Set((ctx.dns?.ns ?? []).map(normaliseHost).filter((h) => h !== "")),
  ).sort();

  /* ---------------------------------------------------------------------- */
  /* 1. Expiry - the highest-stakes fact in this category                    */
  /* ---------------------------------------------------------------------- */

  const renewalFix =
    `Renew it at ${registrarPhrase}, then fix the reason it got here: turn auto-renew on for the domain itself (not just for the hosting or the privacy add-on, which are billed separately at most registrars), and check that the card on file has not itself expired. An expired payment method behind an enabled auto-renew is the single most common cause of a domain lapsing - the setting looks correct right up until the charge is declined. Make sure the registrar's notice emails go to an address that is not hosted on this domain, because once it lapses that mailbox stops receiving mail too.`;

  if (daysToExpiry === null) {
    findings.push({
      id: "dom-expiry-unknown",
      category: "domain",
      severity: "info",
      title: "Registry did not report an expiry date",
      detail: `The RDAP response for ${domain} carries no expiration event, so the remaining registration term could not be measured. Several registries genuinely omit it - a few ccTLDs treat the expiry date as private registrant data, and some thin registries publish only the events the registrar chose to include. This says nothing about whether the registration is healthy; it simply was not published.`,
      fix: `Confirm the expiry date directly in ${registrarPhrase}'s control panel, and set a calendar reminder independent of the registrar's own email notices.`,
      value: registrar === null ? undefined : `registrar: ${registrar}`,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  } else if (daysToExpiry <= 0) {
    const lapsedFor = Math.abs(daysToExpiry);
    findings.push({
      id: "dom-expired",
      category: "domain",
      severity: "critical",
      title: `The domain registration expired ${humanSpan(lapsedFor)} ago`,
      detail: `${domain} passed its expiry date ${expiresOn}${registrar === null ? "" : `, registered through ${registrar}`}. An expired registration does not degrade gradually: at the registry's discretion the nameserver delegation is pulled and the website, the mail, every OAuth callback and every webhook that resolves through this name stop working at the same moment. After the grace period the name enters a redemption period with a restore fee measured in hundreds rather than tens, and after that it is deleted and released - at which point anyone at all may register it and start receiving the password-reset mail for every account tied to an address at this domain. Domain expiry is the one outage that cannot be fixed by rolling back a deploy.`,
      fix: `Renew or restore it now - this is the most urgent item in the whole audit. Inside the grace period a normal renewal at ${registrarPhrase} restores service; after that you need the registrar's redemption/restore process and the fee that comes with it, and ICANN's Expired Registration Recovery Policy sets out what the registrar has to offer you. Once it is back: enable auto-renew, verify the card on file has not itself expired, and move the registrar's notice address off this domain.`,
      value: expiryValue + registrarValue,
      snippet: [
        `# what the registry says right now`,
        `curl -sL https://rdap.org/domain/${domain} | grep -i -A2 expiration`,
        "",
        `# statuses to look for: redemptionPeriod, pendingDelete, clientHold`,
      ].join("\n"),
      docs: ICANN_ERRP,
      weight: 6,
    });
  } else if (daysToExpiry <= 7) {
    findings.push({
      id: "dom-expiry-imminent",
      category: "domain",
      severity: "critical",
      title: `Domain registration expires in ${pluralise(daysToExpiry, "day")}`,
      detail: `${domain} expires ${expiresOn}${registrar === null ? "" : `, registered through ${registrar}`}. Under a week of runway on a domain means auto-renew has either failed or was never switched on - a working auto-renew charges well before this point, so a registration still sitting this close to its date is itself the evidence that the renewal is not going to happen on its own. When it lapses, everything that depends on the name goes at once: site, mail, certificate renewals, OAuth callbacks, webhooks. There is no partial failure and no cache that carries you through.`,
      fix: renewalFix,
      value: expiryValue + registrarValue,
      docs: ICANN_ERRP,
      weight: 6,
    });
  } else if (daysToExpiry <= 30) {
    findings.push({
      id: "dom-expiry-soon",
      category: "domain",
      severity: "warning",
      title: `Domain registration expires in ${pluralise(daysToExpiry, "day")}`,
      detail: `${domain} expires ${expiresOn}${registrar === null ? "" : `, registered through ${registrar}`}. That is inside the window where a failed renewal turns into an outage before anyone notices - registrars send their reminders around 30, 15 and 5 days out, all of them by email, and all of them easy to miss or to have routed to a mailbox nobody reads. Renewing now costs the same as renewing on the last day and removes the whole failure mode.`,
      fix: renewalFix,
      value: expiryValue + registrarValue,
      docs: ICANN_ERRP,
      weight: 5,
    });
  } else if (daysToExpiry <= 60) {
    findings.push({
      id: "dom-expiry-approaching",
      category: "domain",
      severity: "info",
      title: `Domain registration expires in ${pluralise(daysToExpiry, "day")}`,
      detail: `${domain} expires ${expiresOn}${registrar === null ? "" : `, registered through ${registrar}`}. There is no emergency at two months out, and if auto-renew is on this will resolve itself. It is worth a glance now rather than later because the check is cheap: confirm auto-renew is enabled on the domain and that the stored payment method is still valid. Multi-year renewals are also usually the cheapest per year and take the question off the table for longer.`,
      fix: `Confirm auto-renew is enabled at ${registrarPhrase} and that the card on file has not expired. Consider renewing for several years at once - the price per year is normally lower and it removes an annual failure point.`,
      value: expiryValue + registrarValue,
      docs: ICANN_ERRP,
      weight: 3,
    });
  } else {
    findings.push({
      id: "dom-expiry-healthy",
      category: "domain",
      severity: "pass",
      title: `Domain registration runs for another ${humanSpan(daysToExpiry)}`,
      detail: `${domain} is registered until ${expiresAt === null ? "a date beyond the 60-day window this check watches" : formatDate(expiresAt)}${registrar === null ? "" : `, through ${registrar}`} - comfortably outside the window where a missed renewal becomes an outage. Nothing to do here beyond keeping auto-renew and the payment method on file current.`,
      value: expiryValue + registrarValue,
      weight: 5,
    });
  }

  /* --- a very long registration term is a mild positive signal ----------- */

  if (daysToExpiry !== null && daysToExpiry >= 3285) {
    findings.push({
      id: "dom-registration-long",
      category: "domain",
      severity: "info",
      title: `Registration is paid up ${humanSpan(daysToExpiry)} ahead`,
      detail: `The registration runs to ${expiresAt === null ? "a date more than nine years out" : formatDate(expiresAt)}, close to the ten-year maximum term ICANN permits. Nothing is wrong with this - it is a small positive signal. Spam filters and some search quality heuristics read a long paid-up term as an owner who intends to keep the name, because throwaway domains used for phishing are registered for a single year. It also means the annual renewal failure mode simply does not exist here.`,
      value: expiryValue,
      docs: ICANN_LOOKUP,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 2. EPP status codes - locks, holds and pending operations               */
  /* ---------------------------------------------------------------------- */

  if (statuses.length === 0) {
    findings.push({
      id: "dom-status-unavailable",
      category: "domain",
      severity: "info",
      title: "No EPP status codes were reported",
      detail: `The RDAP response for ${domain} contains no status array, so the transfer, update and delete locks could not be evaluated in either direction. Absent statuses mean the registry did not publish them - not that the domain is unlocked. Some ccTLD registries omit the field entirely, and a few return statuses only to authenticated queries. Treat the lock posture below as unmeasured.`,
      fix: `Check the domain's status codes in ${registrarPhrase}'s control panel, or with \`whois ${domain}\`. The one to confirm is clientTransferProhibited, the registrar-level lock that stops a transfer being initiated.`,
      snippet: `whois ${domain} | grep -i status`,
      docs: EPP_STATUS_CODES,
      weight: 1,
    });
  } else {
    findings.push({
      id: "dom-status-codes",
      category: "domain",
      severity: "info",
      title: `Registry reports ${pluralise(statuses.length, "EPP status code")}`,
      detail: `${domain} carries: ${listOf(statuses, 10)}. These are the registry's own record of what may and may not be done to the domain. Codes beginning \`client\` were set by the registrar on the registrant's behalf and can be lifted from the control panel; codes beginning \`server\` were set by the registry itself and the registrar cannot remove them. Reported here so the raw values are visible alongside the checks below.`,
      value: statuses.join(", "),
      docs: EPP_STATUS_CODES,
      weight: 1,
    });

    const inRedemption = hasStatus("redemptionperiod");
    const pendingDelete = hasStatus("pendingdelete");
    const clientHold = hasStatus("clienthold");
    const serverHold = hasStatus("serverhold");

    /* --- the registration has actually lapsed -------------------------- */

    if (inRedemption || pendingDelete) {
      const which = [inRedemption ? "redemptionPeriod" : null, pendingDelete ? "pendingDelete" : null]
        .filter((s): s is string => s !== null)
        .join(" and ");
      findings.push({
        id: "dom-pending-delete",
        category: "domain",
        severity: "critical",
        title: `Domain is in ${which} - the registration has lapsed`,
        detail: `${domain} carries the ${which} status${inRedemption && pendingDelete ? "es" : ""}, which the registry sets after a registration has expired or been deleted rather than as a routine condition. In redemptionPeriod the name is already out of service and can only be brought back through the registrar's restore process, at a fee set well above a normal renewal; pendingDelete is the last five-day window before the name is dropped from the registry and released for anyone to register. Once released, whoever takes it receives every password-reset mail addressed to this domain.${daysToExpiry !== null && daysToExpiry > 0 ? " Note that the expiry date the registry reports is still in the future, which usually means the registration was deleted deliberately rather than allowed to lapse - worth confirming that was intentional." : ""}`,
        fix: `Contact ${registrarPhrase} today and ask for a restore (RGP restore, sometimes called redemption). ICANN's Expired Registration Recovery Policy requires the registrar to make the process available and to publish the fee. In pendingDelete a restore is no longer possible at all - at that point the only options are to wait for the drop and try to re-register, or to use a backorder service, neither of which is reliable.`,
        value: statuses.join(", "),
        docs: ICANN_ERRP,
        weight: 6,
      });
    }

    /* --- the domain is not resolving ----------------------------------- */

    if (clientHold || serverHold) {
      const which = [clientHold ? "clientHold" : null, serverHold ? "serverHold" : null]
        .filter((s): s is string => s !== null)
        .join(" and ");
      findings.push({
        id: "dom-hold",
        category: "domain",
        severity: "critical",
        title: `Domain is on ${which} - it is removed from DNS`,
        detail: `${domain} carries the ${which} status. Hold means the registry does not publish the domain's delegation into the zone at all: regardless of what nameservers are configured, resolvers get NXDOMAIN and the website, the mail and every service on the name are dark. ${serverHold ? "serverHold is set by the registry itself, which normally means a legal or compliance action, a court order, or an unverified registrant contact under ICANN's Whois Accuracy Program - a registrar cannot lift it. " : ""}${clientHold ? "clientHold is set by the registrar, most often for non-payment, an abuse report, or a failed registrant-contact verification. " : ""}This status is never routine and never accidental; someone put it there.`,
        fix: `Contact ${registrarPhrase} and find out why the hold was applied - unpaid invoice, unverified registrant email, or an abuse complaint are the usual three, and the first two are resolved the same day. ${serverHold ? "For a registry-set serverHold the registrar has to escalate to the registry on your behalf; there is no self-service path. " : ""}If the verification email is the cause, note that it was probably sent to an address on this domain, which is currently unreachable.`,
        value: statuses.join(", "),
        docs: EPP_STATUS_CODES,
        weight: 6,
      });
    }

    /* --- a transfer is already in flight -------------------------------- */

    if (hasStatus("pendingtransfer")) {
      findings.push({
        id: "dom-pending-transfer",
        category: "domain",
        severity: "warning",
        title: "A registrar transfer is in progress",
        detail: `${domain} carries the pendingTransfer status, so a transfer to another registrar has been requested and the registry is waiting out the five-day approval window. If you started it, this is expected and it will complete on its own. If you did not, this is what a domain hijack looks like from the outside: an unauthorised transfer request that completes silently unless someone explicitly denies it before the window closes.`,
        fix: `Confirm immediately that the transfer is yours. If it is not, deny it in ${registrarPhrase}'s control panel while the request is still pending - once it completes, recovery goes through ICANN's Transfer Dispute Resolution Policy and takes weeks rather than minutes. Then change the registrar account password, turn on two-factor authentication, and set clientTransferProhibited.`,
        value: statuses.join(", "),
        docs: ICANN_TRANSFER_POLICY,
        weight: 4,
      });
    }

    /* --- delegation missing at the registry ----------------------------- */

    if (hasStatus("inactive")) {
      findings.push({
        id: "dom-status-inactive",
        category: "domain",
        severity: "warning",
        title: "Registry reports the domain as inactive - no nameservers delegated",
        detail: `The \`inactive\` EPP status means the registry holds no nameserver records for ${domain}. A domain in this state is registered but not delegated, so nothing under it resolves.${liveNs.length > 0 ? ` The live NS lookup did return ${listOf(liveNs, 4)}, so either the delegation was added very recently and this RDAP response predates it, or the answer came from a cache.` : ""} On a name that is currently serving a website this is usually the tail end of a nameserver change that has not finished propagating to the registry.`,
        fix: `Set the domain's nameservers at ${registrarPhrase}. Delegation is configured at the registrar, not at the DNS host - creating the zone in a DNS provider does nothing until the registrar points the domain at that provider's nameservers.`,
        value: statuses.join(", "),
        docs: EPP_STATUS_CODES,
        weight: 3,
      });
    }

    /* --- the client-side locks ------------------------------------------ */

    const transferLock = hasStatus("clienttransferprohibited");
    const updateLock = hasStatus("clientupdateprohibited");
    const deleteLock = hasStatus("clientdeleteprohibited");
    const renewLock = hasStatus("clientrenewprohibited");

    if (transferLock) {
      findings.push({
        id: "dom-transfer-lock-present",
        category: "domain",
        severity: "pass",
        title: "Transfer lock is set (clientTransferProhibited)",
        detail: `${domain} carries clientTransferProhibited, so the registry will refuse a transfer request outright until the lock is lifted from ${registrarPhrase}'s control panel. This is the single most valuable status code on a domain: domain hijacking almost always works by obtaining the authorisation code and initiating a transfer, and this lock adds a step that requires access to the registrar account rather than just to an email inbox. It costs nothing and only gets in the way on the rare day you genuinely want to move registrar.`,
        value: statuses.join(", "),
        weight: 4,
      });
    } else {
      findings.push({
        id: "dom-transfer-lock-missing",
        category: "domain",
        severity: "warning",
        title: "No transfer lock - the domain can be transferred away",
        detail: `${domain} does not carry clientTransferProhibited. Without it, a transfer request reaching the registry is processed on the strength of the authorisation code and the registrant email alone, and it completes by default after five days if nobody denies it. This is the most common domain-hijacking vector there is: compromise the mailbox, request the auth code, initiate the transfer, wait. Once the name is at another registrar - frequently in another jurisdiction - getting it back means a formal dispute rather than a support ticket, and in the meantime the attacker controls DNS, mail and certificate issuance for the domain.${statuses.length > 0 ? ` Statuses actually reported: ${listOf(statuses, 6)}.` : ""}`,
        fix: `Turn the registrar lock on. Every registrar exposes it as a "domain lock" or "transfer lock" toggle on the domain's page, it takes one click, it is free, and the only cost is having to switch it off for a few minutes if you ever transfer the domain deliberately. While you are in that account, enable two-factor authentication on it - the lock protects the domain, but the account still protects the lock.`,
        value: statuses.length > 0 ? statuses.join(", ") : undefined,
        docs: ICANN_TRANSFER_POLICY,
        weight: 4,
      });
    }

    if (transferLock && updateLock && deleteLock && renewLock) {
      findings.push({
        id: "dom-locks-complete",
        category: "domain",
        severity: "pass",
        title: "All four registrar-level locks are set",
        detail: `${domain} carries clientTransferProhibited, clientUpdateProhibited, clientDeleteProhibited and clientRenewProhibited. Together these mean the registry will refuse a transfer, a change to the registration record, a deletion or an out-of-band renewal request unless the lock is deliberately lifted from the registrar account first. This is the full default-deny posture, it is what the better registrars apply automatically, and it converts a compromised email inbox from a domain-loss event into an inconvenience.`,
        value: statuses.join(", "),
        weight: 3,
      });
    } else {
      if (!updateLock) {
        findings.push({
          id: "dom-update-lock-missing",
          category: "domain",
          severity: "info",
          title: "No update lock (clientUpdateProhibited)",
          detail: `${domain} does not carry clientUpdateProhibited. That status blocks changes to the registration record itself - the nameserver delegation, the registrant contact, the DS records - until it is lifted. Its absence is not an exposure on its own, because anyone who can change those things already has the registrar account. It is a second line of defence: with the lock set, an attacker inside the account has to take a deliberate, logged extra step before repointing your nameservers, and the change is not silent.`,
          fix: `Enable clientUpdateProhibited at ${registrarPhrase} if it is offered - many registrars group it with the transfer lock under one "lock domain" control. Leave it off if you change nameservers or DS records frequently through an API, where it will simply cause failed calls.`,
          value: statuses.join(", "),
          docs: EPP_STATUS_CODES,
          weight: 2,
        });
      }

      if (!deleteLock) {
        findings.push({
          id: "dom-delete-lock-missing",
          category: "domain",
          severity: "info",
          title: "No delete lock (clientDeleteProhibited)",
          detail: `${domain} does not carry clientDeleteProhibited, the status that makes the registry refuse a delete request for the domain. Deliberate deletion is a rare way to lose a name compared with expiry or transfer, which is why this is an FYI rather than a warning - but a deletion is also the one action with no undo inside the grace window's price, and it is exactly what an attacker with account access does to burn a domain quickly.`,
          fix: `Enable clientDeleteProhibited at ${registrarPhrase}. Like the other client locks it is free, instant, and only needs lifting on the day you intend to give the domain up.`,
          value: statuses.join(", "),
          docs: EPP_STATUS_CODES,
          weight: 2,
        });
      }

      if (!renewLock) {
        findings.push({
          id: "dom-renew-lock-missing",
          category: "domain",
          severity: "info",
          title: "No renew lock (clientRenewProhibited)",
          detail: `${domain} does not carry clientRenewProhibited. This is the least consequential of the four client locks and its absence is not a problem: it blocks an explicit renewal command at the registry, not the registrar's own auto-renew, and its main purpose is to stop a domain being extended by someone other than the owner. It is listed here only because registrars that apply the full lock set apply this one too, so its absence usually just means the domain was locked partially rather than by a default policy.`,
          fix: `Nothing is required. If your registrar exposes a single "lock domain" control that sets all four client statuses, using it is tidier than locking selectively.`,
          value: statuses.join(", "),
          docs: EPP_STATUS_CODES,
          weight: 1,
        });
      }
    }

    /* --- registry-level locks ------------------------------------------- */

    const serverLocks = statuses.filter((s) => {
      const key = statusKey(s);
      return (
        key === "servertransferprohibited" ||
        key === "serverupdateprohibited" ||
        key === "serverdeleteprohibited" ||
        key === "serverrenewprohibited"
      );
    });

    if (serverLocks.length > 0) {
      findings.push({
        id: "dom-server-locks-present",
        category: "domain",
        severity: "info",
        title: `Registry-level locks are in place (${pluralise(serverLocks.length, "status")})`,
        detail: `${domain} carries ${listOf(serverLocks, 4)}, set by the registry rather than by the registrar. On a domain enrolled in a registry lock service this is the strongest protection available - changes require an out-of-band, manually verified request and cannot be made through the registrar's normal interface at all, which is why high-value names use it. The same codes are also applied for compliance reasons such as a UDRP dispute or a court order, so if you did not sign up for a lock service, ask ${registrarPhrase} why they are set.`,
        value: serverLocks.join(", "),
        docs: EPP_STATUS_CODES,
        weight: 1,
      });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 3. DNSSEC - the authoritative answer the resolver could not give        */
  /* ---------------------------------------------------------------------- */

  if (rdap.dnssecSigned === true) {
    findings.push({
      id: "dom-dnssec-signed",
      category: "domain",
      severity: "pass",
      title: "DNSSEC is enabled - the delegation is signed",
      detail: `The registry reports a signed delegation for ${domain}: a DS record is published in the parent zone, which is the half of DNSSEC that people most often forget and without which signing the zone achieves nothing. Validating resolvers can now verify cryptographically that the answers they get for this domain came from your nameservers and were not altered, which closes off cache poisoning and on-path DNS spoofing as ways to redirect your visitors or your mail. This is the authoritative answer from the registry, not an inference from a resolver flag.`,
      value: "secureDNS.delegationSigned = true",
      weight: 3,
    });
  } else if (rdap.dnssecSigned === false) {
    findings.push({
      id: "dom-dnssec-unsigned",
      category: "domain",
      severity: "info",
      title: "DNSSEC is not enabled",
      detail: `The registry reports no signed delegation for ${domain} - there is no DS record in the parent zone, so validating resolvers have nothing to check answers against. This is genuinely optional and it is the majority position: most domains on the internet are unsigned, and being unsigned is not a defect. The trade-off is real in both directions. Signing protects against forged DNS answers - cache poisoning, on-path spoofing - and is the prerequisite for DANE/TLSA records used in mail transport security. Against that, DNSSEC is the one DNS setting that can take a domain completely offline when it is wrong: an expired signature or a DS record that no longer matches the zone's key makes validating resolvers refuse the answer entirely, and the failure is invisible to non-validating clients, which makes it confusing to diagnose. It is worth enabling when the registrar and DNS host manage the key rollover for you, and worth leaving alone if key management would be manual.`,
      fix: `If you want it: enable DNSSEC in your DNS provider first, then publish the resulting DS record at ${registrarPhrase} - both halves are required, and the zone-signing half alone does nothing. Providers that manage both ends (Cloudflare, Route 53 with the registrar in the same account, and most modern registrars) reduce this to one switch. Verify the finished chain with DNSViz before considering it done.`,
      value: "secureDNS.delegationSigned = false",
      docs: ICANN_DNSSEC,
      weight: 2,
    });
  } else {
    findings.push({
      id: "dom-dnssec-unknown",
      category: "domain",
      severity: "info",
      title: "Registry did not report DNSSEC status",
      detail: `The RDAP response for ${domain} contains no \`secureDNS\` object, so whether the delegation is signed is unknown - not unsigned. RFC 9083 makes the member optional and a number of registries omit it. Read this as unmeasured in either direction; the audit's DNS section cannot answer it either, because a stub resolver does not expose the Authenticated Data bit.`,
      fix: `Determine it directly: \`dig +short DS ${domain}\` asks the parent zone whether a delegation signer exists, which is the definitive test. DNSViz walks the full chain from the root and shows exactly where it breaks if it does.`,
      snippet: [
        `# is the delegation signed at the parent?`,
        `dig +short DS ${domain}`,
        `# is the zone itself signed?`,
        `dig +dnssec +short DNSKEY ${domain}`,
        `# full chain analysis:  ${DNSVIZ}${domain}`,
      ].join("\n"),
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Age and trust signals                                               */
  /* ---------------------------------------------------------------------- */

  const registeredOn =
    registeredAt === null ? "a date the RDAP response did not include" : formatDate(registeredAt);
  const ageValue =
    ageDays === null
      ? registeredAt === null
        ? undefined
        : `registered ${formatDate(registeredAt)}`
      : registeredAt === null
        ? `${ageDays} days old`
        : `registered ${formatDate(registeredAt)} (${ageDays} days ago)`;

  if (ageDays === null) {
    findings.push({
      id: "dom-age-unknown",
      category: "domain",
      severity: "info",
      title: "Registry did not report a registration date",
      detail: `No creation event was present in the RDAP response for ${domain}, so the age of the registration could not be computed. Some registries omit it and some redact it. Domain age is a soft trust input for search engines and spam filters rather than a security property, so this is a gap in the report rather than a gap in the domain.`,
      fix: `If you need the figure, ICANN Lookup or a WHOIS query usually reports a creation date even where RDAP omits one.`,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  } else if (ageDays < 30) {
    findings.push({
      id: "dom-age-brand-new",
      category: "domain",
      severity: "info",
      title: `Domain was registered ${pluralise(ageDays, "day")} ago`,
      detail: `${domain} was created on ${registeredOn}, which makes it brand new. Nothing is wrong with a new domain - every domain is new once - but it is worth knowing what a fresh registration costs you for the first few months. Spam filters weight domain age heavily because throwaway domains used for phishing are almost always days old, so mail from this domain is more likely to be greylisted or scored as suspicious than the same mail from an established name. Search engines are similarly cautious about ranking a name with no history. Both effects fade on their own; neither is something to fight.`,
      fix: `Warm it up rather than waiting it out. Get SPF, DKIM and DMARC right before the first bulk send, ramp sending volume gradually instead of starting with a large campaign, and get the site indexed and linked from somewhere established. Renewing for several years at once also reads as intent to keep the name.`,
      value: ageValue,
      weight: 2,
    });
  } else if (ageDays < 180) {
    findings.push({
      id: "dom-age-recent",
      category: "domain",
      severity: "info",
      title: `Domain is ${humanSpan(ageDays)} old`,
      detail: `${domain} was registered on ${registeredOn}. The sharpest new-domain penalties are behind it, but at under six months it still has little history for a search engine or a spam filter to weigh. This is a softer version of the same note: the reputation accrues on its own as the domain sends legitimate mail and accumulates links, and there is no action that meaningfully accelerates it.`,
      value: ageValue,
      weight: 1,
    });
  } else if (ageDays < 730) {
    findings.push({
      id: "dom-age-maturing",
      category: "domain",
      severity: "info",
      title: `Domain is ${humanSpan(ageDays)} old`,
      detail: `${domain} was registered on ${registeredOn}. Past the point where age itself is working against it, and short of the couple of years at which a registration reads as clearly established. Recorded for context rather than as anything to act on - domain age is an input to reputation, not a control you can configure.`,
      value: ageValue,
      weight: 1,
    });
  } else {
    findings.push({
      id: "dom-age-established",
      category: "domain",
      severity: "pass",
      title: `Domain has been registered for ${humanSpan(ageDays)}`,
      detail: `${domain} was created on ${registeredOn}. A registration held continuously for this long is a real asset: search engines and mail reputation systems both treat sustained age as evidence of a genuine operator, and it is the one trust signal that cannot be bought or shortcut. It is also the reason letting this particular name lapse would be more expensive than the renewal fee suggests.`,
      value: ageValue,
      weight: 2,
    });
  }

  /* --- a recent change to the registration record ------------------------ */

  if (daysSinceChange !== null && changedAt !== null && daysSinceChange >= 0 && daysSinceChange < 7) {
    findings.push({
      id: "dom-recently-changed",
      category: "domain",
      severity: "info",
      title: `Registration record was last changed ${daysSinceChange === 0 ? "today" : pluralise(daysSinceChange, "day")}${daysSinceChange === 0 ? "" : " ago"}`,
      detail: `The registry's last-updated event for ${domain} is ${formatDate(changedAt)}. RDAP does not say what changed - the field covers nameservers, contacts, statuses, DS records and a renewal alike - so this is only worth a glance, and it is entirely expected if you renewed, moved DNS provider or edited contact details this week. It is worth more than a glance if you did not: an unexplained change to the registration record, particularly one accompanied by a nameserver difference, is what a domain takeover looks like in the registry's own log.`,
      fix: `If the change was not yours, review the audit log in ${registrarPhrase}'s control panel, confirm the nameservers and registrant contact are still correct, then rotate the account password and enable two-factor authentication.`,
      value: `last changed ${formatDate(changedAt)}`,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 5. Registration hygiene                                                */
  /* ---------------------------------------------------------------------- */

  const source = text(rdap.source);
  const handle = text(rdap.handle);
  const ianaId = text(rdap.registrarIanaId);

  if (registrar !== null) {
    const extras = [
      ianaId === null ? null : `IANA ID ${ianaId}`,
      handle === null ? null : `registry handle ${handle}`,
      source === null ? null : `via ${source}`,
    ].filter((s): s is string => s !== null);

    findings.push({
      id: "dom-registrar",
      category: "domain",
      severity: "info",
      title: `Domain is registered through ${registrar}`,
      detail: `${domain} is sponsored by ${registrar}${ianaId === null ? "" : ` (IANA registrar ID ${ianaId})`}. This is where every fix in this section is applied: renewals, the transfer and update locks, the DS record for DNSSEC, and the registrant contact all live in this registrar's control panel, not in your DNS host or your hosting provider - which are frequently three different companies and are the usual source of confusion when a change appears to have no effect. Whoever controls this account controls the domain, so it is worth treating as a higher-value credential than the hosting account.`,
      value: extras.length > 0 ? `${registrar} · ${extras.join(" · ")}` : registrar,
      docs: ICANN_LOOKUP,
      weight: 1,
    });
  } else {
    findings.push({
      id: "dom-registrar-unknown",
      category: "domain",
      severity: "info",
      title: "Registrar was not identified in the RDAP response",
      detail: `The response for ${domain}${source === null ? "" : `, served by ${source},`} does not name a sponsoring registrar. Thin registries and several ccTLDs omit the registrar entity, and some redact it along with the contact data. It has no bearing on the health of the registration - it only means this report cannot tell you where to go to change things.`,
      fix: `Look the domain up at ICANN Lookup or in your own registrar account to confirm who sponsors it, then note it somewhere your team can find during an incident.`,
      docs: ICANN_LOOKUP,
      weight: 1,
    });
  }

  /* --- registrant privacy: a trade-off, not a verdict -------------------- */

  const registrantName = text(rdap.registrantName);
  const registrantCountry = text(rdap.registrantCountry);

  if (rdap.privacyProtected === true) {
    findings.push({
      id: "dom-privacy-protected",
      category: "domain",
      severity: "pass",
      title: "Registrant contact details are not published",
      detail: `The registration data for ${domain} is redacted or served through a privacy proxy, which is the normal state of a gTLD registration since GDPR: registries publish the technical facts and withhold the personal ones by default. Practically, it means the registrant name, email, address and phone number are not sitting in a public database to be scraped for the transfer-scam letters and SEO spam that follow a new registration. Law enforcement and legitimate legal process still reach the underlying data through the registrar.${registrantCountry === null ? "" : ` A registrant country of ${registrantCountry} is still published, which is standard - jurisdiction is not treated as personal data.`}`,
      value: registrantCountry === null ? "registrant data redacted" : `registrant data redacted · country: ${registrantCountry}`,
      weight: 1,
    });
  } else if (rdap.privacyProtected === false && registrantName !== null) {
    findings.push({
      id: "dom-privacy-public",
      category: "domain",
      severity: "info",
      title: "Registrant contact details are published in full",
      detail: `The RDAP record for ${domain} publishes a registrant name - "${registrantName}"${registrantCountry === null ? "" : `, ${registrantCountry}`} - rather than redacting it. This is a genuine trade-off rather than a fault, and it is worth being deliberate about which side of it you are on. Public registrant data is harvestable: new registrations with visible contacts reliably attract fake renewal invoices, "domain expiration" phishing letters, SEO and directory spam, and it exposes a home address where the registrant is an individual using their own details. On the other side, public data supports accountability - some jurisdictions and business types require the operator to be identifiable, several ccTLD registries mandate publication outright, and for a company that already publishes its address in a legal notice or an imprint, redacting it in RDAP gains nothing and can look evasive.`,
      fix: `Decide rather than default. If the registrant is an individual, enable the registrar's privacy service - it is free at most registrars now - or at minimum replace a home address and personal mailbox with a business address and a role account like domains@${domain}. If publication is required or wanted, keep it, and make sure the published mailbox is one somebody actually monitors, since it is also where transfer approvals and registrar verification mail arrive.`,
      value: registrantCountry === null ? registrantName : `${registrantName} (${registrantCountry})`,
      docs: ICANN_LOOKUP,
      weight: 2,
    });
  } else {
    findings.push({
      id: "dom-privacy-unknown",
      category: "domain",
      severity: "info",
      title: "Registrant contact status could not be determined",
      detail: `The RDAP response for ${domain} does not make it clear whether registrant details are redacted, proxied or simply absent${registrantCountry === null ? "" : ` - a registrant country of ${registrantCountry} is published, but no name`}. Registries differ in how they signal redaction, and some return no entity for the registrant at all. Reported as unknown rather than guessed either way.`,
      fix: `Check what is actually published by looking the domain up at ICANN Lookup, which shows the same fields a stranger would see. If a home address or a personal mailbox is visible and you would rather it were not, the registrar's privacy service removes it.`,
      docs: ICANN_LOOKUP,
      weight: 1,
    });
  }

  /* --- abuse contact ----------------------------------------------------- */

  const abuseEmail = text(rdap.abuseEmail);

  if (abuseEmail !== null) {
    findings.push({
      id: "dom-abuse-contact",
      category: "domain",
      severity: "info",
      title: "Registrar abuse contact is published",
      detail: `Abuse reports about ${domain} are directed to ${abuseEmail}${registrar === null ? "" : ` at ${registrar}`}. ICANN requires accredited registrars to publish a monitored abuse address, and it is reported here because it is useful in both directions: it is where a third party will complain about your domain, and it is the address you use to report abuse of somebody else's. Worth knowing before you need it - complaints sent here can result in a clientHold, so an unmonitored abuse channel at your registrar is a way to lose service without warning.`,
      value: abuseEmail,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  } else {
    findings.push({
      id: "dom-abuse-contact-missing",
      category: "domain",
      severity: "info",
      title: "No registrar abuse contact in the RDAP response",
      detail: `The response for ${domain} includes no abuse contact entity. This is a gap in what was published, not necessarily a gap at the registrar - the abuse address is a required field for ICANN-accredited gTLD registrars, but not every registry includes the registrar's entities in its RDAP output, and ccTLD registries frequently omit them. It matters mainly for the reverse direction: if somebody needs to report abuse originating from this domain, or you need to report abuse to your own registrar, the route is not discoverable here.`,
      fix: `Find your registrar's abuse address on their website and keep it with your incident notes, alongside the registrar login. There is nothing to configure on the domain itself.`,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 6. Nameservers: what the registry has versus what resolves              */
  /* ---------------------------------------------------------------------- */

  if (registryNs.length === 0) {
    findings.push({
      id: "dom-ns-not-reported",
      category: "domain",
      severity: "info",
      title: "Registry did not report any nameservers",
      detail: `The RDAP response for ${domain} lists no nameserver objects. Thin registries and several ccTLDs omit them from RDAP even when the delegation exists, so this is usually a reporting gap rather than a missing delegation.${liveNs.length > 0 ? ` The live NS lookup returned ${listOf(liveNs, 4)}, which confirms the domain is delegated and resolving - the two sides simply could not be compared.` : " The audit's own NS lookup also returned nothing, so the delegation could not be confirmed from either side."} No conclusion is drawn about delegation consistency.`,
      fix: `Compare them yourself if it matters: \`dig +short NS ${domain}\` gives the live answer, and the registrar's control panel shows what the registry holds. They should match exactly.`,
      snippet: `dig +short NS ${domain}`,
      docs: RFC_RDAP_RESPONSES,
      weight: 1,
    });
  } else if (registryNs.length < 2) {
    findings.push({
      id: "dom-ns-insufficient",
      category: "domain",
      severity: "warning",
      title: `Registry holds only ${pluralise(registryNs.length, "nameserver")} for this domain`,
      detail: `The delegation at the registry names ${listOf(registryNs)} and nothing else. Two authoritative nameservers has been the expectation since RFC 1034 and most registries enforce it, for the obvious reason that one is a single point of failure: if it is unreachable the domain does not resolve at all - website, mail, certificate renewals, everything - and resolvers have nowhere else to ask. A single delegated nameserver usually means self-hosted DNS or a nameserver change that was only half applied.`,
      fix: `Add at least one more nameserver in ${registrarPhrase}'s control panel, ideally on separate infrastructure from the first. Every managed DNS provider issues two or more by default; if you are running your own, a secondary on a different network and provider is the point of the exercise.`,
      value: registryNs.join(", "),
      docs: "https://www.rfc-editor.org/rfc/rfc1034",
      weight: 3,
    });
  }

  if (registryNs.length > 0 && liveNs.length > 0) {
    const registrySet = new Set(registryNs);
    const liveSet = new Set(liveNs);
    const onlyAtRegistry = registryNs.filter((h) => !liveSet.has(h));
    const onlyLive = liveNs.filter((h) => !registrySet.has(h));

    if (onlyAtRegistry.length === 0 && onlyLive.length === 0) {
      findings.push({
        id: "dom-ns-delegation-consistent",
        category: "domain",
        severity: "pass",
        title: `Registry delegation matches the live nameservers (${pluralise(registryNs.length, "nameserver")})`,
        detail: `The nameservers held at the registry and the NS records returned by a live lookup are the same set: ${listOf(registryNs)}. That is the expected steady state, and confirming it is worth doing because the two can drift apart silently - a delegation change made at the DNS host but never at the registrar leaves the old nameservers authoritative indefinitely, with the new zone serving nobody.`,
        value: registryNs.join(", "),
        weight: 2,
      });
    } else {
      findings.push({
        id: "dom-ns-mismatch",
        category: "domain",
        severity: "warning",
        title: "Registry nameservers do not match the live NS records",
        detail: `The registry holds ${listOf(registryNs)} for ${domain}, while a live NS lookup returns ${listOf(liveNs)}.${onlyAtRegistry.length > 0 ? ` At the registry but not live: ${listOf(onlyAtRegistry, 6)}.` : ""}${onlyLive.length > 0 ? ` Live but not at the registry: ${listOf(onlyLive, 6)}.` : ""} There are two ordinary explanations and one bad one. Ordinarily, a delegation change is mid-flight and the parent zone or a resolver cache has not caught up - that resolves itself within a day. Ordinarily, a name has been left behind after a migration, in which case a nameserver nobody maintains is still authoritative for the domain and will answer with a stale zone the day the new provider has an outage. The bad explanation is that the delegation was changed by someone who should not have been able to change it, which is the first observable step of a domain takeover.`,
        fix: `Establish which set is correct. The registry's list is the one that counts - it is what the parent zone publishes - so if the live answer looks right and the registry's does not, the delegation was never updated at ${registrarPhrase} and needs to be. Remove nameservers you no longer use rather than leaving them delegated. If neither list is one you recognise, treat it as a compromise of the registrar account: rotate the password, enable two-factor authentication, and set clientTransferProhibited and clientUpdateProhibited.`,
        value: `registry: ${registryNs.join(", ")} | live: ${liveNs.join(", ")}`,
        snippet: `dig +short NS ${domain}`,
        docs: RFC_RDAP_RESPONSES,
        weight: 3,
      });
    }
  } else if (registryNs.length > 0) {
    findings.push({
      id: "dom-ns-not-compared",
      category: "domain",
      severity: "info",
      title: "Registry nameservers could not be compared with live DNS",
      detail: `The registry holds ${listOf(registryNs)} for ${domain}, but ${ctx.dns === null ? "no DNS lookups completed during this scan" : "the live NS query returned nothing"}, so the two sides could not be checked against each other. The registry list is reported here as-is; no conclusion is drawn about whether the live delegation agrees with it.`,
      fix: `Compare them by hand with \`dig +short NS ${domain}\` - the live answer should be the same set of hostnames the registrar shows for the domain.`,
      value: registryNs.join(", "),
      snippet: `dig +short NS ${domain}`,
      weight: 1,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* 7. Cross-check: the certificate outliving the domain                    */
  /* ---------------------------------------------------------------------- */

  const certDays = finiteOrNull(ctx.tls?.daysUntilExpiry ?? null);
  const certValidTo = parseIso(ctx.tls?.validTo ?? null);

  if (daysToExpiry !== null && daysToExpiry <= 30 && certDays !== null && certDays - daysToExpiry >= 30) {
    findings.push({
      id: "dom-expiry-before-certificate",
      category: "domain",
      severity: "warning",
      title: "The TLS certificate outlives the domain registration",
      detail: `The certificate for this host is valid for another ${pluralise(certDays, "day")}${certValidTo === null ? "" : ` (until ${formatDate(certValidTo)})`}, while the domain registration itself runs out in ${daysToExpiry <= 0 ? `${pluralise(Math.abs(daysToExpiry), "day")} ago - it has already expired` : pluralise(daysToExpiry, "day")}${expiresAt === null ? "" : `, ${expiresOn}`}. Certificate monitoring is the thing teams almost always have in place and domain expiry is the thing they almost never do, so this is the shape of outage that arrives with no warning at all: every dashboard stays green, the certificate is fine, and the site disappears anyway because the name stopped resolving. The certificate becomes worthless at the same moment - it certifies a domain someone else may now register.`,
      fix: `Renew the domain first; the certificate is not the problem here. Then add domain expiry to whatever already watches your certificate expiry - most uptime and monitoring services check both, and the registration date is the one worth alerting on 60 days out rather than 7, because a lapsed domain has a redemption fee attached where a lapsed certificate does not.`,
      value: `domain: ${expiryValue} | certificate: ${certValidTo === null ? `${certDays} days remaining` : `expires ${formatDate(certValidTo)} (${certDays} days)`}`,
      docs: ICANN_ERRP,
      weight: 3,
    });
  }

  return findings;
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The registrable domain, for prose.
 *
 * `RdapInfo` carries the registry's handle rather than the name itself, so the
 * label comes from the DNS layer when it resolved a registrable domain, and from
 * the host of the URL we actually fetched otherwise. Never returns an empty
 * string, so no finding can interpolate a blank where a domain should be.
 */
function domainLabel(ctx: PageContext): string {
  const fromDns = typeof ctx.dns?.domain === "string" ? ctx.dns.domain.replace(/\.$/, "").trim() : "";
  if (fromDns !== "") return fromDns.toLowerCase();

  const fromDnsHost = typeof ctx.dns?.host === "string" ? ctx.dns.host.replace(/\.$/, "").trim() : "";
  if (fromDnsHost !== "") return fromDnsHost.toLowerCase();

  try {
    const host = new URL(ctx.finalUrl).hostname.replace(/\.$/, "");
    if (host !== "") return host.toLowerCase();
  } catch {
    // Fall through to the generic label below.
  }

  return "this domain";
}
