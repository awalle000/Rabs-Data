import nodemailer from 'nodemailer';
import env from '../config/environment.js';

let transporter = null;
const smtpSendTimeoutMs = 12000;
export const googleAppsScriptTimeoutMs = 12000;
export const smtpTimeoutOptions = Object.freeze({
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 10000,
});

const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[character]));

function getTransporter() {
  if (transporter) return transporter;

  const { host, port, secure, user, pass } = env.email.smtp;
  const missingVariables = [
    !host && 'SMTP_HOST',
    !Number.isFinite(port) && 'SMTP_PORT',
    !user && 'SMTP_USER',
    !pass && 'SMTP_PASS',
    !env.email.from && 'EMAIL_FROM',
  ].filter(Boolean);
  const variablesWithWhitespace = [
    host && host !== host.trim() && 'SMTP_HOST',
    user && user !== user.trim() && 'SMTP_USER',
    pass && pass !== pass.trim() && 'SMTP_PASS',
    env.email.from && env.email.from !== env.email.from.trim() && 'EMAIL_FROM',
  ].filter(Boolean);
  if (missingVariables.length) {
    console.error('[EmailService] SMTP startup verification failed.', {
      provider: env.email.provider,
      stage: 'configuration',
      code: 'SMTP_CONFIGURATION_INCOMPLETE',
      missingVariables,
      variablesWithWhitespace,
    });
    return null;
  }

  const senderAddress = env.email.from.match(/<([^>]+)>/)?.[1] || env.email.from;
  const senderMatchesAuthenticatedAccount = senderAddress.trim().toLowerCase() === user.trim().toLowerCase();
  const smtpUserLooksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user);
  const emailFromConfigured = Boolean(env.email.from);
  const gmailTlsShapeValid = host.toLowerCase() !== 'smtp.gmail.com'
    || (port === 465 && secure === true)
    || (port === 587 && secure === false);
  console.info('[EmailService] SMTP transport configured.', {
    provider: env.email.provider,
    host,
    port,
    secure,
    credentialsConfigured: true,
    emailFromConfigured,
    variablesWithWhitespace,
    smtpUserLooksLikeEmail,
    senderMatchesAuthenticatedAccount,
    gmailTlsShapeValid,
  });
  if (!gmailTlsShapeValid) {
    console.warn('[EmailService] Gmail SMTP TLS settings are invalid.', {
      invalidVariables: ['SMTP_PORT', 'SMTP_SECURE'],
      expectedCombinations: ['465/true', '587/false'],
    });
    return null;
  }
  if (host.toLowerCase() === 'smtp.gmail.com' && !smtpUserLooksLikeEmail) {
    console.warn('[EmailService] Gmail SMTP_USER is not a full email address.', { invalidVariables: ['SMTP_USER'] });
    return null;
  }
  if (host.toLowerCase() === 'smtp.gmail.com' && !senderMatchesAuthenticatedAccount) {
    console.warn('[EmailService] Gmail sender differs from SMTP_USER; verify the sender is a configured Gmail alias.', {
      code: 'SMTP_SENDER_IDENTITY_MISMATCH',
    });
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    ...smtpTimeoutOptions,
  });

  return transporter;
}

const runSmtpOperation = async (mailer, operation, timeoutMs, command) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('SMTP operation timed out');
          error.code = 'ETIMEDOUT';
          error.command = command;
          try { mailer.close(); } catch { /* The timed-out transport is discarded. */ }
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const sendSmtpMail = (mailer, message, timeoutMs = smtpSendTimeoutMs) =>
  runSmtpOperation(mailer, () => mailer.sendMail(message), timeoutMs, 'OVERALL_SEND');

export const validateGoogleAppsScriptConfig = ({ url, secret }) => {
  const missingVariables = [
    !url && 'GOOGLE_APPS_SCRIPT_URL',
    !secret && 'GOOGLE_APPS_SCRIPT_SECRET',
  ].filter(Boolean);
  const invalidVariables = [
    secret && secret !== secret.trim() && 'GOOGLE_APPS_SCRIPT_SECRET',
  ].filter(Boolean);
  let endpointValid = false;
  try {
    const endpoint = new URL(url);
    endpointValid = endpoint.protocol === 'https:'
      && endpoint.hostname === 'script.google.com'
      && /^\/macros\/s\/[^/]+\/exec\/?$/.test(endpoint.pathname)
      && !endpoint.username
      && !endpoint.password;
  } catch {
    endpointValid = false;
  }
  if (url && !endpointValid) invalidVariables.push('GOOGLE_APPS_SCRIPT_URL');
  return { missingVariables, invalidVariables, endpointValid };
};

export const sendGoogleAppsScriptEmail = async ({
  url,
  secret,
  to,
  subject,
  textBody,
  htmlBody,
  requestId,
  fetchImpl = fetch,
  timeoutMs = googleAppsScriptTimeoutMs,
}) => {
  const config = validateGoogleAppsScriptConfig({ url, secret });
  if (config.missingVariables.length || config.invalidVariables.length) {
    console.error('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'failed',
      stage: 'configuration',
      code: 'GOOGLE_APPS_SCRIPT_CONFIGURATION_INVALID',
      missingVariables: config.missingVariables,
      invalidVariables: config.invalidVariables,
    });
    return { outcome: 'failed' };
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, to, subject, textBody, htmlBody }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
  } catch (error) {
    const isTimeout = error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT';
    console.warn('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'unknown',
      stage: 'request',
      code: isTimeout ? 'GOOGLE_APPS_SCRIPT_TIMEOUT' : 'GOOGLE_APPS_SCRIPT_NETWORK_ERROR',
    });
    return { outcome: 'unknown' };
  }

  if (!response.ok) {
    console.warn('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'unknown',
      stage: 'http',
      code: 'GOOGLE_APPS_SCRIPT_HTTP_ERROR',
      httpStatus: response.status,
    });
    return { outcome: 'unknown' };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    console.warn('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'unknown',
      stage: 'response',
      code: 'GOOGLE_APPS_SCRIPT_INVALID_JSON',
      httpStatus: response.status,
    });
    return { outcome: 'unknown' };
  }

  if (payload?.ok === true) {
    console.info('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'accepted',
      stage: 'script_response',
      httpStatus: response.status,
    });
    return { outcome: 'accepted' };
  }

  if (payload?.ok === false) {
    console.error('[EmailService] Password-reset delivery result.', {
      provider: 'google-apps-script',
      requestId,
      outcome: 'failed',
      stage: 'script_response',
      code: 'GOOGLE_APPS_SCRIPT_REJECTED',
      httpStatus: response.status,
    });
    return { outcome: 'failed' };
  }

  console.warn('[EmailService] Password-reset delivery result.', {
    provider: 'google-apps-script',
    requestId,
    outcome: 'unknown',
    stage: 'response',
    code: 'GOOGLE_APPS_SCRIPT_INVALID_RESPONSE',
    httpStatus: response.status,
  });
  return { outcome: 'unknown' };
};

export const verifySmtpTransport = async () => {
  console.info('[EmailService] Startup email provider selected.', { provider: env.email.provider });
  if (env.email.provider === 'google-apps-script') {
    const config = validateGoogleAppsScriptConfig(env.email.googleAppsScript);
    const valid = !config.missingVariables.length && !config.invalidVariables.length;
    console.info('[EmailService] Google Apps Script provider configuration checked.', {
      provider: 'google-apps-script',
      endpointValid: config.endpointValid,
      secretConfigured: Boolean(env.email.googleAppsScript.secret),
      missingVariables: config.missingVariables,
      invalidVariables: config.invalidVariables,
      outcome: valid ? 'ready' : 'failed',
    });
    return { outcome: valid ? 'ready' : 'failed' };
  }
  if (env.email.provider === 'resend') {
    const missingVariables = [
      !env.email.resendApiKey && 'RESEND_API_KEY',
      !env.email.from && 'EMAIL_FROM',
    ].filter(Boolean);
    const invalidVariables = [
      env.email.resendApiKey && env.email.resendApiKey !== env.email.resendApiKey.trim() && 'RESEND_API_KEY',
      env.email.from && env.email.from !== env.email.from.trim() && 'EMAIL_FROM',
    ].filter(Boolean);
    const valid = !missingVariables.length && !invalidVariables.length;
    console.info('[EmailService] Resend provider configuration checked.', {
      provider: 'resend',
      apiKeyConfigured: Boolean(env.email.resendApiKey),
      senderConfigured: Boolean(env.email.from),
      missingVariables,
      invalidVariables,
      outcome: valid ? 'ready' : 'failed',
    });
    return { outcome: valid ? 'ready' : 'failed' };
  }
  if (env.email.provider !== 'smtp') {
    console.warn('[EmailService] SMTP startup verification skipped because a non-SMTP provider is selected.', {
      provider: env.email.provider,
      code: 'SMTP_VERIFICATION_SKIPPED',
    });
    return { outcome: 'skipped' };
  }
  try {
    const mailer = getTransporter();
    if (!mailer) {
      console.error('[EmailService] SMTP startup verification failed.', {
        provider: 'smtp',
        stage: 'configuration',
        code: 'SMTP_CONFIGURATION_INVALID',
      });
      return { outcome: 'failed', code: 'SMTP_CONFIGURATION_INVALID' };
    }
    await runSmtpOperation(mailer, () => mailer.verify(), smtpSendTimeoutMs, 'OVERALL_VERIFY');
    console.info('[EmailService] SMTP transport verification succeeded.', { provider: 'smtp' });
    return { outcome: 'verified' };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') transporter = null;
    const details = summarizeSmtpError(error);
    const code = details.code === 'SMTP_TIMEOUT' ? 'SMTP_VERIFY_TIMEOUT' : details.code;
    console.error('[EmailService] SMTP transport verification failed.', { stage: details.stage, code });
    return { outcome: 'failed', code };
  }
};

export const summarizeSmtpError = (error) => {
  const code = String(error?.code || 'SMTP_ERROR').toUpperCase();
  const command = String(error?.command || '').toUpperCase();
  if (code === 'EAUTH') return { outcome: 'failed', stage: 'authentication', code: 'SMTP_AUTH_FAILED' };
  if (['ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code)) {
    return { outcome: 'failed', stage: 'connection', code };
  }
  if (code === 'EENVELOPE' || command === 'RCPT TO') {
    return { outcome: 'failed', stage: 'recipient', code };
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    const beforeMessage = ['CONN', 'CONNECT', 'GREETING', 'AUTH'].includes(command);
    return {
      outcome: beforeMessage ? 'failed' : 'unknown',
      stage: beforeMessage ? 'connection' : 'delivery',
      code: code === 'ETIMEDOUT' ? 'SMTP_TIMEOUT' : code,
    };
  }
  return { outcome: 'unknown', stage: 'delivery', code: 'SMTP_ERROR' };
};

export const summarizeSmtpInfo = (info) => {
  const acceptedCount = Array.isArray(info?.accepted) ? info.accepted.length : 0;
  const rejectedCount = Array.isArray(info?.rejected) ? info.rejected.length : 0;
  return {
    outcome: acceptedCount > 0 ? 'accepted' : rejectedCount > 0 ? 'failed' : 'unknown',
    acceptedCount,
    rejectedCount,
    messageId: typeof info?.messageId === 'string' ? info.messageId : undefined,
  };
};

const logDelivery = (requestId, details) => {
  console.info('[EmailService] Password-reset SMTP result.', { requestId, ...details });
};

/**
 * Sends a password reset email to the user.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.userName - User's display name
 * @param {string} options.resetUrl - Full HTTPS password reset link
 * @param {number} options.expiresInMinutes - Expiration time in minutes (default 15)
 * @returns {Promise<{ outcome: 'accepted' | 'failed' | 'unknown' }>}
 */
export async function sendPasswordResetEmail({ to, userName, resetUrl, requestId, expiresInMinutes = 15 }) {
  const subject = 'Reset Your Rabs Data Password';
  const nameGreeting = userName ? `Hello ${userName},` : 'Hello,';
  const safeNameGreeting = userName ? `Hello ${escapeHtml(userName)},` : 'Hello,';
  const safeResetUrl = escapeHtml(resetUrl);

  const textContent = `
${nameGreeting}

We received a request to reset your password for your Rabs Data account.

To reset your password, visit the following link:
${resetUrl}

This link is valid for ${expiresInMinutes} minutes and can only be used once.

Security Notice:
If you did not request a password reset, please ignore this email. Your password will remain unchanged, and your account is secure.

Best regards,
The Rabs Data Team
`.trim();

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Your Password</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .brand { font-size: 24px; font-weight: 700; color: #2563eb; margin-bottom: 24px; display: inline-block; text-decoration: none; }
    .btn { display: inline-block; background-color: #2563eb; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; margin: 24px 0; }
    .footer { margin-top: 32px; font-size: 13px; color: #64748b; line-height: 1.5; border-top: 1px solid #e2e8f0; padding-top: 16px; }
    .link { word-break: break-all; color: #2563eb; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">Rabs Data</div>
    <h2>Password Reset Request</h2>
    <p>${safeNameGreeting}</p>
    <p>We received a request to reset the password for your Rabs Data account. Click the button below to choose a new password:</p>
    <p style="text-align: center;">
      <a href="${safeResetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset My Password</a>
    </p>
    <p style="font-size: 14px; color: #475569;">
      Or copy and paste this link into your browser:<br>
      <a href="${safeResetUrl}" class="link">${safeResetUrl}</a>
    </p>
    <p style="font-size: 14px; color: #ef4444; font-weight: 500;">
      ⚠️ This link will expire in <strong>${expiresInMinutes} minutes</strong> and can only be used once.
    </p>
    <div class="footer">
      <p><strong>Security Notice:</strong> If you did not request this password reset, please ignore this email. Your password will remain unchanged and your account remains secure.</p>
      <p>&copy; ${new Date().getFullYear()} Rabs Data. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
`.trim();

  if (env.email.provider === 'google-apps-script') {
    return sendGoogleAppsScriptEmail({
      ...env.email.googleAppsScript,
      to,
      subject,
      textBody: textContent,
      htmlBody: htmlContent,
      requestId,
    });
  }

  if (env.email.provider === 'resend') {
    if (!env.email.resendApiKey || !env.email.from) {
      console.warn('[EmailService] Password-reset delivery result.', {
        provider: 'resend',
        requestId,
        outcome: 'failed',
        stage: 'configuration',
        code: 'RESEND_CONFIGURATION_INCOMPLETE',
        missingVariables: [
          !env.email.resendApiKey && 'RESEND_API_KEY',
          !env.email.from && 'EMAIL_FROM',
        ].filter(Boolean),
      });
      return { outcome: 'failed' };
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.email.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: env.email.from, to, subject, text: textContent, html: htmlContent }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const outcome = response.status >= 500 ? 'unknown' : 'failed';
        console.error('[EmailService] Password-reset delivery result.', {
          provider: 'resend',
          requestId,
          outcome,
          stage: 'http',
          code: `RESEND_HTTP_${response.status}`,
          httpStatus: response.status,
        });
        return { outcome };
      }
      console.info('[EmailService] Password-reset delivery result.', {
        provider: 'resend',
        requestId,
        outcome: 'accepted',
        stage: 'provider_response',
        httpStatus: response.status,
      });
      return { outcome: 'accepted' };
    } catch {
      console.error('[EmailService] Password-reset delivery result.', {
        provider: 'resend',
        requestId,
        outcome: 'unknown',
        stage: 'request',
        code: 'RESEND_REQUEST_ERROR',
      });
      return { outcome: 'unknown' };
    }
  }

  const mailer = getTransporter();
  if (!mailer) {
    logDelivery(requestId, { outcome: 'failed', stage: 'configuration', code: 'SMTP_CONFIGURATION_INCOMPLETE' });
    return { outcome: 'failed' };
  }

  try {
    const info = await sendSmtpMail(mailer, {
      from: env.email.from,
      to,
      subject,
      text: textContent,
      html: htmlContent,
    });
    const summary = summarizeSmtpInfo(info);
    const outcome = summary.outcome;
    logDelivery(requestId, {
      outcome,
      stage: 'smtp_response',
      acceptedCount: summary.acceptedCount,
      rejectedCount: summary.rejectedCount,
      messageId: summary.messageId,
      code: outcome === 'failed' ? 'SMTP_RECIPIENT_REJECTED' : undefined,
    });
    return { outcome };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') transporter = null;
    const details = summarizeSmtpError(error);
    logDelivery(requestId, details);
    return { outcome: details.outcome };
  }
}
