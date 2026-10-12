/**
 * Emails freshly issued Hammer keys to the buyer. Best effort: the keys are
 * also on /account/licenses, so a mail failure is logged, never fatal.
 *
 * Transport: the same SMTP settings the contact form uses, environment first
 * (SMTP_HOST/PORT/USER/PASSWORD/FROM), then settings.json's contact.smtp.
 */

import nodemailer from "nodemailer";
import { getSettings } from "../settings.server";

type Smtp = { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string };

async function resolveSmtp(): Promise<Smtp | null> {
  let fromSettings: { host?: string; port?: number | string; secure?: boolean; user?: string; pass?: string; from?: string } = {};
  try {
    const { settings } = await getSettings();
    fromSettings = settings.contact?.smtp ?? {};
  } catch {
    // Settings unavailable (no GitHub config, tests): environment only.
  }
  const host = process.env.SMTP_HOST || fromSettings.host;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT || fromSettings.port || 587);
  const secure = typeof fromSettings.secure === "boolean" ? fromSettings.secure : port === 465;
  const user = process.env.SMTP_USER || fromSettings.user;
  const pass = process.env.SMTP_PASSWORD || fromSettings.pass;
  const from = process.env.SMTP_FROM || fromSettings.from || user;
  if (!from) return null;
  return { host, port, secure, user, pass, from };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type LicenseEmailInput = {
  to: string;
  licensee: string;
  keys: { id: string; key: string }[];
  /** Absolute URL of the licences page. */
  /** Absolute URL of the licences page; the line is left out when unknown. */
  manageUrl?: string;
};

/** Sends the keys; returns false (after logging) when mail is not configured or fails. */
export async function sendLicenseKeysEmail(input: LicenseEmailInput): Promise<boolean> {
  if (!input.to || input.keys.length === 0) return false;
  const cfg = await resolveSmtp();
  if (!cfg) {
    console.warn("[licensing] SMTP is not configured; keys were issued but not emailed to", input.to);
    return false;
  }
  const plural = input.keys.length === 1 ? "key" : "keys";
  const keyLines = input.keys.map((k) => k.key).join("\n\n");
  const text = [
    `Hi ${input.licensee || "there"},`,
    "",
    `Thanks for buying Hammer. Here ${input.keys.length === 1 ? "is your licence key" : `are your ${input.keys.length} licence keys`}:`,
    "",
    keyLines,
    "",
    "Each key is for one computer. In Hammer open Settings, then Licence, and paste the key.",
    "Your subscription renews yearly; your keys keep working as long as it is active.",
    "",
    ...(input.manageUrl ? [`Manage your keys and billing: ${input.manageUrl}`, ""] : []),
    "Devforge",
  ].join("\n");
  const html =
    `<p>Hi ${escapeHtml(input.licensee || "there")},</p>` +
    `<p>Thanks for buying Hammer. Here ${input.keys.length === 1 ? "is your licence key" : `are your ${input.keys.length} licence keys`}:</p>` +
    input.keys
      .map(
        (k) =>
          `<pre style="padding:12px;border:1px solid #ddd;border-radius:8px;white-space:pre-wrap;word-break:break-all;font-size:13px">${escapeHtml(k.key)}</pre>`,
      )
      .join("") +
    `<p>Each key is for one computer. In Hammer open <strong>Settings</strong>, then <strong>Licence</strong>, and paste the key.<br>` +
    `Your subscription renews yearly; your keys keep working as long as it is active.</p>` +
    (input.manageUrl ? `<p><a href="${escapeHtml(input.manageUrl)}">Manage your keys and billing</a></p>` : "") +
    `<p>Devforge</p>`;
  try {
    const transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });
    const info = await transport.sendMail({
      from: cfg.from,
      to: input.to,
      subject: `Your Hammer licence ${plural}`,
      text,
      html,
    });
    if (info.rejected && info.rejected.length > 0) {
      console.error("[licensing] SMTP rejected", info.rejected);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[licensing] could not email keys to", input.to, (err as Error).message);
    return false;
  }
}
