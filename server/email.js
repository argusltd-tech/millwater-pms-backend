// Outgoing email through Resend (https://resend.com), using its HTTP API directly.
//
// Environment:
//   RESEND_API_KEY        API key from the Resend dashboard (required to send)
//   EMAIL_FROM            Sender on a domain verified in Resend, e.g. "Millwater <onboarding@millwater.ng>"
//   EMAIL_REPLY_TO        Optional fallback reply-to address
//   EMAIL_ASSET_BASE_URL  Public base URL for email images (defaults to the first ALLOWED_ORIGINS entry,
//                         then Render's RENDER_EXTERNAL_URL)
//   RESEND_API_URL        Override of the API endpoint (tests only)

const DEFAULT_API_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15_000;

export function emailConfig(env = process.env) {
  return {
    apiKey: (env.RESEND_API_KEY ?? '').trim(),
    from: (env.EMAIL_FROM ?? '').trim(),
    replyTo: (env.EMAIL_REPLY_TO ?? '').trim(),
    apiUrl: (env.RESEND_API_URL ?? '').trim() || DEFAULT_API_URL,
  };
}

/** Why email cannot be sent, or null when it is configured. */
export function emailConfigProblem(config = emailConfig()) {
  if (!config.apiKey) return 'Email is not set up: RESEND_API_KEY is missing on the server.';
  if (!config.from) return 'Email is not set up: EMAIL_FROM is missing on the server.';
  if (!/<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(config.from)) {
    return 'EMAIL_FROM must be an address such as "Millwater <onboarding@your-domain>".';
  }
  return null;
}

/** Public base URL that email images are served from (no trailing slash). */
export function emailAssetBaseUrl(env = process.env) {
  const explicit = (env.EMAIL_ASSET_BASE_URL ?? '').trim();
  const firstOrigin = (env.ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).find(Boolean);
  const base = explicit || firstOrigin || (env.RENDER_EXTERNAL_URL ?? '').trim() || `http://localhost:${env.PORT || 4000}`;
  return base.replace(/\/+$/, '');
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

  const body = {
    from: config.from,
    to: toList,
    subject,
    html,
    text,
    ...(cc.length ? { cc } : {}),
    ...(replyToList.length ? { reply_to: replyToList } : {}),
  };

  let response;
  try {
    response = await fetchImpl(config.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
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
  if (!response.ok) {
    const detail = typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`The email service rejected the message: ${detail}`);
  }
  if (typeof payload?.id !== 'string') throw new Error('The email service returned an unexpected response.');
  return { id: payload.id };
}
