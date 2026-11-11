// Outgoing email over HTTP, through one of two providers:
//
//   resend    Real delivery through Resend (https://resend.com). Needs a domain verified in Resend.
//   mailtrap  Mailtrap Email Sandbox (https://mailtrap.io). Nothing is delivered: every message is
//             caught in a Mailtrap inbox where it can be viewed. Used for demos until DNS access
//             for the client's domain allows Resend to be verified.
//
// Environment:
//   EMAIL_PROVIDER        "resend" or "mailtrap". If unset: mailtrap when only MAILTRAP_API_TOKEN
//                         is set, otherwise resend.
//   EMAIL_FROM            Sender, e.g. "Millwater <onboarding@millwater.ng>". For Resend it must be on
//                         the verified domain. Optional for Mailtrap (a demo sender is used).
//   EMAIL_REPLY_TO        Optional fallback reply-to address
//   EMAIL_ASSET_BASE_URL  Public base URL for email images (defaults to the first ALLOWED_ORIGINS entry,
//                         then Render's RENDER_EXTERNAL_URL)
//   RESEND_API_KEY        Resend API key
//   MAILTRAP_API_TOKEN    Mailtrap API token (Settings → API Tokens, with access to the sandbox inbox)
//   MAILTRAP_INBOX_ID     Numeric id of the sandbox inbox (shown in the inbox URL)
//   RESEND_API_URL / MAILTRAP_API_URL  Endpoint overrides (tests only)

const RESEND_API_URL = 'https://api.resend.com/emails';
const MAILTRAP_API_URL = 'https://sandbox.api.mailtrap.io/api/send';
const MAILTRAP_DEMO_FROM = 'Millwater <onboarding@millwater-demo.test>';
const SEND_TIMEOUT_MS = 15_000;

export const PROVIDER_LABELS = { resend: 'Resend', mailtrap: 'Mailtrap sandbox' };

export function emailConfig(env = process.env) {
  const value = key => (env[key] ?? '').trim();
  const explicit = value('EMAIL_PROVIDER').toLowerCase();
  const provider = explicit || (value('MAILTRAP_API_TOKEN') && !value('RESEND_API_KEY') ? 'mailtrap' : 'resend');
  if (provider === 'mailtrap') {
    return {
      provider,
      apiKey: value('MAILTRAP_API_TOKEN'),
      inboxId: value('MAILTRAP_INBOX_ID'),
      from: value('EMAIL_FROM') || MAILTRAP_DEMO_FROM,
      replyTo: value('EMAIL_REPLY_TO'),
      apiUrl: value('MAILTRAP_API_URL') || MAILTRAP_API_URL,
    };
  }
  return {
    provider,
    apiKey: value('RESEND_API_KEY'),
    from: value('EMAIL_FROM'),
    replyTo: value('EMAIL_REPLY_TO'),
    apiUrl: value('RESEND_API_URL') || RESEND_API_URL,
  };
}

const ADDRESS = /<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;

/** Why email cannot be sent, or null when it is configured. */
export function emailConfigProblem(config = emailConfig()) {
  const provider = config.provider ?? 'resend';
  if (provider === 'mailtrap') {
    if (!config.apiKey) return 'Email is not set up: MAILTRAP_API_TOKEN is missing on the server.';
    if (!/^\d+$/.test(config.inboxId ?? '')) return 'Email is not set up: MAILTRAP_INBOX_ID (the numeric sandbox inbox id) is missing on the server.';
  } else if (provider === 'resend') {
    if (!config.apiKey) return 'Email is not set up: RESEND_API_KEY is missing on the server.';
    if (!config.from) return 'Email is not set up: EMAIL_FROM is missing on the server.';
  } else {
    return `EMAIL_PROVIDER must be "resend" or "mailtrap" (it is "${provider}").`;
  }
  if (!ADDRESS.test(config.from)) return 'EMAIL_FROM must be an address such as "Millwater <onboarding@your-domain>".';
  return null;
}

/** Public base URL that email images are served from (no trailing slash). */
export function emailAssetBaseUrl(env = process.env) {
  const explicit = (env.EMAIL_ASSET_BASE_URL ?? '').trim();
  const firstOrigin = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).find(Boolean);
  const base = explicit || firstOrigin || (env.RENDER_EXTERNAL_URL ?? '').trim() || `http://localhost:${env.PORT || 4000}`;
  return base.replace(/\/+$/, '');
}

/** "Millwater <a@b.ng>" → { name: 'Millwater', email: 'a@b.ng' } */
export function parseAddress(value) {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  return match ? { email: match[2].trim(), ...(match[1].trim() ? { name: match[1].trim() } : {}) } : { email: value.trim() };
}

function requestFor(config, { toList, cc, replyToList, subject, html, text, idempotencyKey }) {
  if ((config.provider ?? 'resend') === 'mailtrap') {
    return {
      url: `${config.apiUrl.replace(/\/+$/, '')}/${config.inboxId}`,
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: {
        from: parseAddress(config.from),
        to: toList.map(parseAddress),
        ...(cc.length ? { cc: cc.map(parseAddress) } : {}),
        subject,
        html,
        text,
        category: 'Onboarding',
        ...(replyToList.length ? { headers: { 'Reply-To': replyToList.join(', ') } } : {}),
      },
    };
  }
  return {
    url: config.apiUrl,
    headers: { Authorization: `Bearer ${config.apiKey}`, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: {
      from: config.from,
      to: toList,
      subject,
      html,
      text,
      ...(cc.length ? { cc } : {}),
      ...(replyToList.length ? { reply_to: replyToList } : {}),
    },
  };
}

/** Pulls a readable error out of either provider's error response. */
function errorDetail(payload, status) {
  if (typeof payload?.message === 'string') return payload.message;
  if (Array.isArray(payload?.errors) && payload.errors.length) return payload.errors.join('; ');
  if (typeof payload?.error === 'string') return payload.error;
  return `HTTP ${status}`;
}

/**
 * Sends one email. Returns { id } on success; throws an Error with a readable message otherwise.
 * `idempotencyKey` makes retries of the same message safe on Resend's side.
 */
export async function sendEmail({ to, cc = [], replyTo = [], subject, html, text, idempotencyKey }, config = emailConfig(), fetchImpl = fetch) {
  const problem = emailConfigProblem(config);
  if (problem) throw new Error(problem);
  const toList = [to].flat().filter(Boolean);
  if (!toList.length) throw new Error('The email has no recipient.');
  const replyToList = [replyTo].flat().filter(Boolean);
  if (!replyToList.length && config.replyTo) replyToList.push(config.replyTo);

  const request = requestFor(config, { toList, cc, replyToList, subject, html, text, idempotencyKey });
  let response;
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? 'The email service did not respond in time.' : 'Could not reach the email service.');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error bodies are reported by status below.
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`The email service rejected the message: ${errorDetail(payload, response.status)}`);
  }
  const id = typeof payload?.id === 'string' ? payload.id : Array.isArray(payload?.message_ids) ? payload.message_ids[0] : null;
  if (typeof id !== 'string') throw new Error('The email service returned an unexpected response.');
  return { id };
}
