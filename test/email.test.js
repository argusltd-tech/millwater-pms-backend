import test from 'node:test';
import assert from 'node:assert/strict';
import { emailAssetBaseUrl, emailConfigProblem, sendEmail } from '../server/email.js';
import { formatLetterDate, lagosToday, renderOnboardingEmail } from '../server/onboardingEmail.js';
import { parseSupportUserIds } from '../server/customers.js';

const sample = {
  companyName: 'Acme <Steel> & Co',
  contactName: 'Ada Obi',
  supplyStartDate: new Date('2026-12-01T00:00:00Z'),
  letterDate: new Date('2026-11-11T00:00:00Z'),
  supports: [
    { fullName: 'Customer Service', email: 'cs@millwater.ng', phone: '+234 801 000 0000' },
    { fullName: 'Second Agent', email: 'agent2@millwater.ng', phone: null },
  ],
  accountName: 'Millwater Limited',
  bankName: 'Zenith Bank',
  accountNumber: '1012345678',
  supplierName: 'Millwater Limited',
  signatoryName: 'H. Fash',
  signatoryTitle: 'Chief Operating Officer',
  assetBaseUrl: 'https://pms.example.com',
};

test('formats letter dates like the template', () => {
  assert.equal(formatLetterDate(new Date('2026-11-11T00:00:00Z')), 'Wednesday 11/11/2026');
  assert.equal(lagosToday(new Date('2026-11-11T23:30:00Z')).toISOString().slice(0, 10), '2026-11-12');
});

test('renders the onboarding email with every placeholder filled and escaped', () => {
  const { subject, html, text } = renderOnboardingEmail(sample);
  assert.equal(subject, 'Welcome to Millwater – on-boarding for Acme <Steel> & Co');
  assert.ok(html.includes('Acme &lt;Steel&gt; &amp; Co'));
  assert.ok(!html.includes('<Steel>'));
  assert.ok(html.includes('Dear Ada Obi,'));
  assert.ok(html.includes('starting <strong>Tuesday 01/12/2026</strong>'));
  assert.ok(html.includes('Wednesday 11/11/2026'));
  assert.ok(html.includes('cs@millwater.ng') && html.includes('agent2@millwater.ng') && html.includes('+234 801 000 0000'));
  assert.ok(html.includes('Zenith Bank') && html.includes('1012345678'));
  assert.ok(html.includes('src="https://pms.example.com/api/email-assets/millwater-logo-white.png"'));
  assert.ok(html.includes('alt="Millwater"'));
  assert.ok(!/\[[A-Z][^\]]*\]/.test(html), 'no template placeholders left');
  assert.ok(!html.includes('<svg'), 'no inline SVG (Gmail and Outlook drop it)');
  assert.ok(text.includes('- Second Agent, agent2@millwater.ng'));
});

test('reports missing email configuration', () => {
  assert.match(emailConfigProblem({ apiKey: '', from: 'a@b.co' }), /RESEND_API_KEY/);
  assert.match(emailConfigProblem({ apiKey: 're_x', from: '' }), /EMAIL_FROM/);
  assert.match(emailConfigProblem({ apiKey: 're_x', from: 'not an address' }), /EMAIL_FROM must/);
  assert.equal(emailConfigProblem({ apiKey: 're_x', from: 'Millwater <hello@millwater.ng>' }), null);
  assert.equal(emailAssetBaseUrl({ ALLOWED_ORIGINS: 'https://pms.example.com/, http://localhost:3000' }), 'https://pms.example.com');
  assert.equal(emailAssetBaseUrl({ EMAIL_ASSET_BASE_URL: 'https://cdn.example.com/', ALLOWED_ORIGINS: 'https://x.test' }), 'https://cdn.example.com');
});

test('sends through the Resend API', async () => {
  const config = { apiKey: 're_test', from: 'Millwater <hello@millwater.ng>', replyTo: '', apiUrl: 'https://resend.test/emails' };
  let seen;
  const fakeFetch = async (url, options) => {
    seen = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ id: 'email_123' }) };
  };
  const result = await sendEmail({ to: 'ops@acme.ng', cc: ['cs@millwater.ng'], replyTo: ['cs@millwater.ng'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', idempotencyKey: 'welcome/1' }, config, fakeFetch);
  assert.deepEqual(result, { id: 'email_123' });
  assert.equal(seen.url, 'https://resend.test/emails');
  assert.equal(seen.options.headers.Authorization, 'Bearer re_test');
  assert.equal(seen.options.headers['Idempotency-Key'], 'welcome/1');
  assert.deepEqual(seen.body.to, ['ops@acme.ng']);
  assert.deepEqual(seen.body.cc, ['cs@millwater.ng']);
  assert.deepEqual(seen.body.reply_to, ['cs@millwater.ng']);

  const rejecting = async () => ({ ok: false, status: 422, json: async () => ({ message: 'The from domain is not verified.' }) });
  await assert.rejects(sendEmail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }, config, rejecting), /not verified/);
  await assert.rejects(sendEmail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' }, { ...config, apiKey: '' }, fakeFetch), /RESEND_API_KEY/);
});

test('validates support contact selections', () => {
  assert.ok(parseSupportUserIds(undefined).error);
  assert.ok(parseSupportUserIds([]).error);
  assert.deepEqual(parseSupportUserIds(['a', 'a', 'b']), { ids: ['a', 'b'] });
  assert.ok(parseSupportUserIds(['1', '2', '3', '4', '5', '6']).error);
});
