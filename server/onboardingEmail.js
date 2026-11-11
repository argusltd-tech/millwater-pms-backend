// Customer onboarding ("welcome") email, from Millwater's millwater_onboarding.html design.
// Rebuilt for email clients: table layout and inline styles (Gmail and Outlook drop CSS grid,
// flexbox, CSS variables and inline SVG), with the logo served as hosted PNG images.

import { writeAudit } from './audit.js';
import { emailAssetBaseUrl, emailConfigProblem, sendEmail } from './email.js';
import { getSettings } from './settings.js';

export const WELCOME_TEMPLATE = 'welcome_onboarding';
const NAVY = '#142657';
const BLUE = '#3f70ed';
const PALE = '#edf4ff';
const INK = '#171b26';
const FONT = 'Arial, Helvetica, sans-serif';

const escapeHtml = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Wednesday 11/11/2026" from a date (calendar date in UTC, as stored for date-only columns). */
export function formatLetterDate(date) {
  const d = new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** Today's calendar date in Lagos (UTC+1), as a UTC-midnight Date. */
export function lagosToday(now = new Date()) {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000);
  return new Date(Date.UTC(lagos.getUTCFullYear(), lagos.getUTCMonth(), lagos.getUTCDate()));
}

/**
 * Builds the email. `data`:
 *   companyName, contactName, supplyStartDate, letterDate,
 *   supports: [{ fullName, email, phone }],
 *   accountName, bankName, accountNumber, supplierName, signatoryName, signatoryTitle, assetBaseUrl
 */
export function renderOnboardingEmail(data) {
  const e = escapeHtml;
  const supplier = data.supplierName || 'Millwater Limited';
  const startDate = formatLetterDate(data.supplyStartDate);
  const letterDate = formatLetterDate(data.letterDate);
  const assets = `${data.assetBaseUrl}/api/email-assets`;
  const subject = `Welcome to Millwater – on-boarding for ${data.companyName}`;
  const preheader = `Your electricity supply from ${supplier} starts ${startDate}. Your support contacts and payment details are inside.`;

  const cell = (content, extra = '') => `<td style="padding:10px 12px;background:${PALE};border-right:1px solid #ffffff;font-family:${FONT};font-size:13px;color:${INK};${extra}">${content}</td>`;
  const head = label => `<th align="left" style="padding:10px 12px;background:${NAVY};color:#ffffff;border-right:1px solid #9aa6c4;font-family:${FONT};font-size:13px;font-weight:bold;">${label}</th>`;
  const supportRows = data.supports.map(person => `<tr>${cell(e(person.fullName))}${cell(`<a href="mailto:${e(person.email)}" style="color:${INK};text-decoration:none;">${e(person.email)}</a>`, 'word-break:break-all;')}${cell(person.phone ? `<a href="tel:${e(person.phone.replace(/\s+/g, ''))}" style="color:${INK};text-decoration:none;">${e(person.phone)}</a>` : '—')}</tr>`).join('');
  const bankCell = (value, label) => `<td class="stack" valign="middle" style="padding:15px 14px;background:${BLUE};color:#ffffff;font-family:${FONT};border:2px solid ${PALE};">
            <div style="font-size:16px;font-weight:bold;line-height:1.3;word-break:break-word;">${e(value || '—')}</div>
            <div style="font-size:11px;line-height:1.3;color:#dbe5ff;margin-top:3px;">${label}</div>
          </td>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>Millwater | Customer On-boarding</title>
<style>
  @media only screen and (max-width: 560px) {
    .outer { padding: 0 !important; }
    .container { width: 100% !important; }
    .pad { padding-left: 20px !important; padding-right: 20px !important; }
    .hero-text { padding: 22px 20px !important; }
    .hero-art { width: 120px !important; }
    .hero-art img { width: 120px !important; height: auto !important; }
    .hero-title { font-size: 22px !important; }
    .stack { display: block !important; width: auto !important; }
    .contacts td, .contacts th { padding: 8px 6px !important; font-size: 11px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f3f5f9;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f9;">
  <tr>
    <td class="outer" align="center" style="padding:28px 14px;">
      <table role="presentation" class="container" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:640px;background:#ffffff;">
        <!-- Hero -->
        <tr>
          <td bgcolor="#244aab" style="background-color:#244aab;background-image:linear-gradient(155deg,#3e70ed 0%,#244aab 43%,#10204d 100%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td class="hero-text" valign="top" style="padding:26px 0 26px 34px;font-family:${FONT};color:#ffffff;">
                  <img src="${assets}/millwater-logo-white.png" width="180" height="23" alt="Millwater" style="display:block;border:0;outline:none;color:#ffffff;font-size:22px;font-weight:bold;font-family:${FONT};">
                  <div class="hero-title" style="margin:26px 0 0 0;font-size:30px;font-weight:300;line-height:1.2;letter-spacing:0.5px;color:#ffffff;white-space:nowrap;">ON-BOARDING FOR</div>
                  <div style="margin:10px 0 12px 0;padding:4px 9px;background:#ffffff;color:#172b61;font-size:14px;font-weight:bold;border-radius:2px;display:inline-block;">${e(data.companyName)}</div>
                  <div><span style="display:inline-block;padding:4px 13px;border-radius:20px;background:#4779f4;color:#ffffff;font-size:13px;">${e(letterDate)}</span></div>
                </td>
                <td class="hero-art" valign="bottom" align="right" width="260" style="padding:0;width:260px;">
                  <img src="${assets}/millwater-hero-mark.png" width="260" height="150" alt="" style="display:block;border:0;outline:none;">
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Welcome -->
        <tr>
          <td class="pad" style="background:${PALE};padding:34px;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};">
            <p style="margin:0 0 15px;"><strong>Dear ${e(data.contactName)},</strong></p>
            <p style="margin:0 0 15px;">We are delighted to welcome you as a new customer of ${e(supplier)} and to commence the supply of reliable electricity starting <strong>${e(startDate)}</strong>.</p>
            <p style="margin:0;">Your electricity supply will be provided on a post-paid basis, with each billing cycle running from the first day to the last day of the month. Joint meter readings will be conducted at the end of each billing cycle, and invoices will be issued within five business days of the following month, following the joint meter reading by both parties.</p>
          </td>
        </tr>
        <!-- Support contacts -->
        <tr>
          <td class="pad" style="padding:34px;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};">
            <p style="margin:0 0 12px;font-weight:bold;">For your convenience, we have designated support contacts:</p>
            <table role="presentation" class="contacts" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
              <tr>${head('Name')}${head('Email')}${head('Telephone')}</tr>
              ${supportRows}
            </table>
          </td>
        </tr>
        <!-- Payment -->
        <tr>
          <td class="pad" align="center" style="background:${PALE};padding:24px 34px 28px;font-family:${FONT};">
            <p style="margin:0 auto 18px;color:${NAVY};font-size:17px;font-weight:bold;line-height:1.35;">Payment is due within 5 business days of receiving invoice and should be made into:</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;text-align:left;">
              <tr>
                ${bankCell(data.accountName || supplier, 'Company name')}
                ${bankCell(data.bankName, 'Bank name')}
                ${bankCell(data.accountNumber, 'Account number')}
              </tr>
            </table>
          </td>
        </tr>
        <!-- Closing -->
        <tr>
          <td class="pad" style="padding:30px 34px 40px;font-family:${FONT};font-size:14px;line-height:1.5;color:${INK};">
            <p style="margin:0 0 28px;">We remain committed to delivering reliable electricity and responsive support. Please do not hesitate to reach out to our team for any assistance.</p>
            <div>Best regards,<br>For ${e(supplier)}:</div>
            <div style="font-family:'Brush Script MT','Segoe Script',cursive;font-size:30px;font-style:italic;margin:8px 0 0;line-height:1.2;">${e(data.signatoryName)}</div>
            <div style="font-weight:bold;">${e(data.signatoryTitle)}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `ON-BOARDING FOR ${data.companyName}`,
    letterDate,
    '',
    `Dear ${data.contactName},`,
    '',
    `We are delighted to welcome you as a new customer of ${supplier} and to commence the supply of reliable electricity starting ${startDate}.`,
    '',
    'Your electricity supply will be provided on a post-paid basis, with each billing cycle running from the first day to the last day of the month. Joint meter readings will be conducted at the end of each billing cycle, and invoices will be issued within five business days of the following month, following the joint meter reading by both parties.',
    '',
    'For your convenience, we have designated support contacts:',
    ...data.supports.map(person => `- ${person.fullName}, ${person.email}${person.phone ? `, ${person.phone}` : ''}`),
    '',
    'Payment is due within 5 business days of receiving invoice and should be made into:',
    `Company name: ${data.accountName || supplier}`,
    `Bank name: ${data.bankName || '—'}`,
    `Account number: ${data.accountNumber || '—'}`,
    '',
    'We remain committed to delivering reliable electricity and responsive support. Please do not hesitate to reach out to our team for any assistance.',
    '',
    'Best regards,',
    `For ${supplier}:`,
    data.signatoryName,
    data.signatoryTitle,
  ].join('\n');

  return { subject, html, text };
}

/** Reasons the onboarding email cannot be sent yet for this customer, or null. */
export function onboardingEmailProblem(customer, settings) {
  const configProblem = emailConfigProblem();
  if (configProblem) return configProblem;
  if (!customer.supportAssignments.length) return 'Assign at least one support contact first.';
  if (!customer.bankAccount && (!settings.bankName || !settings.bankAccountNumber)) return 'Select the bank account this customer pays into first.';
  return null;
}

/**
 * Sends the onboarding email to a customer and records it in their message history and the
 * audit log. Never throws for delivery problems: the result says whether it was sent.
 * Returns { status: 'sent' | 'failed', note, messageId }.
 */
export async function sendOnboardingEmail(prisma, req, customerId) {
  const [customer, settings] = await Promise.all([
    prisma.customer.findUnique({
      where: { id: customerId },
      include: { bankAccount: true, supportAssignments: { include: { user: true }, orderBy: { createdAt: 'asc' } } },
    }),
    getSettings(prisma),
  ]);
  if (!customer) return { status: 'failed', note: 'Customer not found.' };

  const supports = customer.supportAssignments.map(assignment => assignment.user);
  const email = renderOnboardingEmail({
    companyName: customer.enterpriseName,
    contactName: customer.contactPerson,
    supplyStartDate: customer.onboardingDate,
    letterDate: lagosToday(),
    supports,
    // The customer's assigned account; the old single account in Settings is only a fallback.
    accountName: customer.bankAccount?.accountName ?? (settings.bankAccountName || settings.companyName),
    bankName: customer.bankAccount?.bankName ?? settings.bankName,
    accountNumber: customer.bankAccount?.accountNumber ?? settings.bankAccountNumber,
    supplierName: settings.companyName,
    signatoryName: settings.emailSignatoryName,
    signatoryTitle: settings.emailSignatoryTitle,
    assetBaseUrl: emailAssetBaseUrl(),
  });

  const message = await prisma.customerMessage.create({
    data: {
      customerId: customer.id,
      channel: 'email',
      templateType: WELCOME_TEMPLATE,
      subject: email.subject,
      body: email.text,
      recipient: customer.email,
      status: 'queued',
      statusNote: 'Sending…',
      sentById: req.user?.id ?? null,
    },
  });

  const problem = onboardingEmailProblem(customer, settings);
  let status = 'failed';
  let note = problem;
  let providerMessageId = null;
  if (!problem) {
    try {
      const supportEmails = supports.map(person => person.email);
      const result = await sendEmail({
        to: customer.email,
        cc: supportEmails,
        replyTo: supportEmails,
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: `welcome/${message.id}`,
      });
      status = 'sent';
      note = `Sent via Resend to ${customer.email}${supportEmails.length ? `, copied to ${supportEmails.join(', ')}` : ''}.`;
      providerMessageId = result.id;
    } catch (error) {
      note = error.message;
    }
  }

  await prisma.customerMessage.update({ where: { id: message.id }, data: { status, statusNote: note, providerMessageId } });
  await writeAudit(prisma, req, {
    action: status === 'sent' ? 'SEND_WELCOME_EMAIL' : 'WELCOME_EMAIL_FAILED',
    entity: 'customers',
    entityId: customer.id,
    details: status === 'sent'
      ? `Onboarding email sent to ${customer.email} for ${customer.accountNumber}.`
      : `Onboarding email to ${customer.email} for ${customer.accountNumber} was not sent: ${note}`,
  });
  return { status, note, messageId: message.id };
}
