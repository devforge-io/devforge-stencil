import nodemailer from "nodemailer";
import { getSettings } from "./settings.server";

export interface ContactSubmission {
  name: string;
  email: string;
  subject?: string;
  message: string;
}

interface ResolvedSmtp {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Resolve the contact recipient + SMTP transport from settings.json, with env
 * overrides (SMTP_HOST/PORT/USER/PASSWORD/FROM). Returns null when the minimum
 * config (recipient + host + from) is missing.
 */
async function resolveContactConfig(): Promise<ResolvedSmtp | null> {
  const { settings } = await getSettings();
  const c = settings.contact ?? {};
  const smtp = c.smtp ?? {};

  const to = c.toEmail;
  const host = process.env.SMTP_HOST || smtp.host;
  if (!to || !host) return null;

  const port = Number(process.env.SMTP_PORT || smtp.port || 587);
  const secure = typeof smtp.secure === "boolean" ? smtp.secure : port === 465;
  const user = process.env.SMTP_USER || smtp.user;
  const pass = process.env.SMTP_PASSWORD || smtp.pass;
  const from = process.env.SMTP_FROM || smtp.from || user;
  if (!from) return null;

  return { host, port, secure, user, pass, from, to };
}

/** Whether the contact form is usable (recipient + SMTP configured). */
export async function isContactConfigured(): Promise<boolean> {
  return (await resolveContactConfig()) !== null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Returns an error message for an invalid submission, or null when valid. */
export function validateSubmission(sub: Partial<ContactSubmission>): string | null {
  if (!sub.name?.trim()) return "Please enter your name.";
  if (!sub.email?.trim() || !EMAIL_RE.test(sub.email.trim())) return "Please enter a valid email address.";
  if (!sub.message?.trim()) return "Please enter a message.";
  if (sub.message.length > 10000) return "Message is too long.";
  return null;
}

/** Verbose SMTP logging (the full protocol conversation) when CONTACT_DEBUG is set. */
const CONTACT_DEBUG = process.env.CONTACT_DEBUG === "1" || process.env.CONTACT_DEBUG === "true";

/** Email a validated contact submission to the configured recipient. */
export async function sendContactMessage(sub: ContactSubmission): Promise<void> {
  const cfg = await resolveContactConfig();
  if (!cfg) {
    const { settings } = await getSettings();
    const c = settings.contact ?? {};
    const smtp = c.smtp ?? {};
    console.log("[contact] NOT CONFIGURED — need recipient + host + from. Present:", {
      toEmail: !!c.toEmail,
      host: !!(process.env.SMTP_HOST || smtp.host),
      from: !!(process.env.SMTP_FROM || smtp.from || process.env.SMTP_USER || smtp.user),
    });
    throw new Error("Contact form is not configured — set the recipient, SMTP host, and from address in Settings.");
  }

  console.log("[contact] sending via SMTP", {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user ?? "(none)",
    hasPass: !!cfg.pass,
    from: cfg.from,
    to: cfg.to,
  });

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    logger: CONTACT_DEBUG,
    debug: CONTACT_DEBUG,
  });

  // Surface connection/auth problems with a clear error before we try to send.
  try {
    await transport.verify();
    console.log("[contact] SMTP connection + auth OK");
  } catch (err) {
    console.log("[contact] SMTP verify failed (bad host/port/secure or auth):", err);
    throw err;
  }

  const name = sub.name.trim();
  const email = sub.email.trim();
  const subject = sub.subject?.trim();
  const message = sub.message.trim();

  const info = await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    replyTo: `${name} <${email}>`,
    subject: subject ? `[Contact] ${subject}` : `New contact form message from ${name}`,
    text: `Name: ${name}\nEmail: ${email}${subject ? `\nSubject: ${subject}` : ""}\n\n${message}`,
    html:
      `<p><strong>Name:</strong> ${escapeHtml(name)}<br>` +
      `<strong>Email:</strong> ${escapeHtml(email)}` +
      (subject ? `<br><strong>Subject:</strong> ${escapeHtml(subject)}` : "") +
      `</p><hr><p style="white-space:pre-wrap">${escapeHtml(message)}</p>`,
  });

  console.log("[contact] sendMail result", {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  });
  if (info.rejected && info.rejected.length > 0) {
    throw new Error(`SMTP rejected recipient(s): ${info.rejected.join(", ")}`);
  }
}
