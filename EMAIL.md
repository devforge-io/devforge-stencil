# Email & Contact Form

Stencil can email contact-form submissions to a configured recipient over SMTP.
It's a server-rendered endpoint (`POST /contact`) plus SMTP settings — no client
JavaScript is required, so it works on a static/SSR marketing page.

- **Endpoint:** `POST /contact` → sends an email to the configured recipient.
- **Config:** recipient + SMTP transport, set in **Settings → Contact** (stored
  in `settings.json`), with environment-variable overrides.
- **Transport:** [nodemailer](https://nodemailer.com/).

---

## Configuration

### In the admin (Settings → Contact)

| Field | Meaning |
|---|---|
| **Send submissions to** | The recipient address (`contact.toEmail`). |
| **SMTP Host** | Mail server hostname. |
| **Port** | `587` (STARTTLS) or `465` (implicit TLS). Defaults to `587`. |
| **Username** | SMTP auth user (omit for an unauthenticated relay). |
| **Password** | SMTP auth password (write-only — see below). |
| **From address** | The `From:` header. Defaults to the username. |
| **Use TLS (port 465)** | Implicit TLS. Leave off for STARTTLS on 587/25. |

The **password field is write-only**: it's never sent back to the browser, and
leaving it blank on save keeps the stored value. The rest of the config is shown
so you can edit it.

### In `settings.json`

The config lives under a `contact` key in the repo's `settings.json`:

```json
{
  "contact": {
    "toEmail": "hello@example.com",
    "smtp": {
      "host": "smtp.example.com",
      "port": 587,
      "secure": false,
      "user": "apikey",
      "pass": "super-secret",
      "from": "Website <site@example.com>"
    }
  }
}
```

### Environment variables (recommended for secrets)

Because `settings.json` is committed to your content repo, the SMTP **password**
lives in the repo unless you use an env var. These env vars **override** the
corresponding `settings.json` values:

| Env var | Overrides |
|---|---|
| `SMTP_HOST` | `contact.smtp.host` |
| `SMTP_PORT` | `contact.smtp.port` |
| `SMTP_USER` | `contact.smtp.user` |
| `SMTP_PASSWORD` | `contact.smtp.pass` |
| `SMTP_FROM` | `contact.smtp.from` |

**Recommended:** leave the password blank in the UI and set `SMTP_PASSWORD` in
your environment (e.g. Vercel project env vars) so it never touches the repo.
The recipient (`toEmail`) has no env override — set it in Settings.

### Resolution & precedence

The transport is considered **configured** only when a **recipient**, a
**host**, and a **from** address all resolve. Precedence per field:

```
env var  >  settings.json  >  built-in default
```

- `port` defaults to `587`.
- `secure` defaults to `true` when the port is `465`, otherwise `false`
  (an explicit checkbox value in Settings always wins).
- `from` falls back to the SMTP `user` when unset.

If the minimum config is missing, `POST /contact` returns an error (the message
isn't silently dropped).

---

## The `/contact` endpoint

### `GET /contact`

Serves the published **page** assigned the path `/contact` (build it in the
visual editor and give it the URL path `/contact`). If no page claims that path,
the configured 404 page (or a plain `Not Found`) is returned. This lets your
contact page and its form handler share one URL.

### `POST /contact`

Emails the submission to the configured recipient.

**Form fields:**

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Sender's name. |
| `email` | yes | Must look like an email; used as `Reply-To`. |
| `subject` | no | Prefixes the email subject. |
| `message` | yes | Body. Max 10,000 characters. |
| `_gotcha` | no | **Honeypot** — must stay empty. Bots that fill it are silently accepted and dropped. Hide it with CSS. |
| `_redirect` | no | For the no-JS flow: where to send the browser afterward (same-origin only). |

**The email:** `Reply-To` is set to `Name <email>` (so you can reply straight to
the sender); the subject is `[Contact] <subject>` or, without a subject,
`New contact form message from <name>`; the body is sent as text and HTML.

### Responses

The endpoint adapts to how it's called:

- **Plain HTML form** (no JS): responds with a **302 redirect** back to
  `_redirect`, else the `Referer`, else `/` — with `?contact=sent` on success or
  `?contact=error` on failure. (Off-origin redirect targets fall back to `/`.)
- **`fetch` with `Accept: application/json`:** responds with JSON:

  ```json
  { "ok": true }
  { "ok": false, "error": "Please enter a valid email address." }
  ```

**Status codes:** `200` sent (or a `302` redirect for the HTML flow), `400`
validation error, `502` the message couldn't be sent (SMTP error).

---

## Example contact form (no JavaScript)

Drop this into any page (e.g. the page you assign to `/contact`):

```html
<form method="post" action="/contact">
  <input name="name" required placeholder="Your name">
  <input name="email" type="email" required placeholder="you@example.com">
  <input name="subject" placeholder="Subject">
  <textarea name="message" required placeholder="Your message"></textarea>

  <!-- Spam honeypot: keep it visually hidden; real users never fill it. -->
  <input name="_gotcha" tabindex="-1" autocomplete="off" aria-hidden="true"
         style="position:absolute;left:-9999px">

  <!-- Optional: where to land after sending. -->
  <input type="hidden" name="_redirect" value="/thank-you">

  <button type="submit">Send message</button>
</form>
```

### Showing a success / error message (no JS)

After the redirect the URL carries `?contact=sent` or `?contact=error`. On a
page-builder page you can surface a message with a **conditional component**
keyed on `query.contact` (e.g. show a "Thanks!" block when `query.contact` is
`sent`), or point `_redirect` at a dedicated `/thank-you` page.

### Submitting with `fetch` (progressive enhancement)

```js
const res = await fetch("/contact", {
  method: "POST",
  headers: { Accept: "application/json" },
  body: new FormData(formEl),
});
const { ok, error } = await res.json();
```

---

## Testing locally

- Set the recipient + SMTP in **Settings → Contact** (or via env vars).
- For local testing without a real mailbox, point SMTP at a catcher like
  [Mailpit](https://github.com/axllent/mailpit) or MailHog
  (`SMTP_HOST=localhost`, `SMTP_PORT=1025`, no auth).
- Submit the form and confirm the message arrives; on failure the endpoint logs
  `[contact] send failed: …` server-side and returns a `502`.

---

## Troubleshooting ("it never sent")

`POST /contact` logs each step to the server console. Watch your dev server (or
Vercel function logs) while submitting the form. You'll see, in order:

```
[contact] POST received; fields: [ 'name', 'email', 'subject', 'message' ]
[contact] sending via SMTP { host, port, secure, user, hasPass, from, to }
[contact] SMTP connection + auth OK
[contact] sendMail result { messageId, accepted: [...], rejected: [], response }
[contact] message sent OK
```

If a message isn't arriving, the logs pinpoint where it stopped:

| Log line | Meaning / fix |
|---|---|
| `honeypot '_gotcha' was filled …` | The `_gotcha` field had a value (bot, or browser autofill), so it was **silently dropped**. Make sure that field is empty/hidden — this is the most common "it says sent but nothing arrives". |
| `validation failed: …` | A required field was missing or the email was invalid — check the field `name` attributes match `name`/`email`/`message`. The logged `fields:` array shows what actually arrived. |
| `NOT CONFIGURED — need recipient + host + from` | The recipient, SMTP host, or from address didn't resolve. Set them in **Settings → Contact** (or via `SMTP_*` env vars). |
| `SMTP verify failed …` | Wrong host/port/`secure`, blocked port, or bad credentials. Common: port `465` needs **TLS on**; port `587` needs **TLS off** (STARTTLS). |
| `sendMail result … rejected: [ '…' ]` | The server accepted the connection but refused the recipient. |

For the **full SMTP protocol conversation** (handshake, AUTH, envelope), set the
`CONTACT_DEBUG=1` environment variable and resubmit — nodemailer will log every
line it exchanges with the mail server.

> Note: the honeypot and validation branches return **success to the browser**
> (a bot shouldn't learn it was caught), so a dropped submission can look "sent"
> on the page while the logs say otherwise. Always check the logs.

## Where things live

| File | Responsibility |
|---|---|
| `app/lib/contact.server.ts` | Resolve config (settings + env), validate a submission, send via nodemailer. |
| `app/routes/contact/route.tsx` | `GET` (serve the assigned page) + `POST` (handle + email the submission). |
| `app/lib/settings.server.ts` | The `contact` shape on `StencilSettings`. |
| `app/routes/_dashboard/content+/settings/route.tsx` | The **Contact** settings section (with write-only password). |
| `.env.example` | Documents the optional `SMTP_*` env vars. |

**Dependency:** `nodemailer` (server-only; imported through the `.server.ts`
module so it never reaches the client bundle).

---

## Notes & limitations

- **Secrets in the repo:** prefer `SMTP_PASSWORD` (env) over storing the password
  in `settings.json`. If you already saved one and want to rotate it, blank the
  field and set the env var, or overwrite it in Settings.
- **Spam:** protection is a honeypot + required-field/email validation. For a
  high-traffic site add a CAPTCHA or rate limiting in front of `POST /contact`.
- **Deliverability:** send from a domain you control and set up SPF/DKIM so mail
  isn't marked as spam. Many hosts block outbound port 25 — use 587 or 465 via a
  provider (SendGrid, Postmark, Mailgun, SES, …).
