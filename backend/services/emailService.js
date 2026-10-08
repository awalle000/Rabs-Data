import nodemailer from 'nodemailer';
import env from '../config/environment.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { host, port, secure, user, pass } = env.email.smtp;
  if (!host || !user) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  return transporter;
}

/**
 * Sends a password reset email to the user.
 *
 * @param {Object} options
 * @param {string} options.to - Recipient email
 * @param {string} options.userName - User's display name
 * @param {string} options.resetUrl - Full HTTPS password reset link
 * @param {number} options.expiresInMinutes - Expiration time in minutes (default 15)
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendPasswordResetEmail({ to, userName, resetUrl, expiresInMinutes = 15 }) {
  const mailer = getTransporter();

  const subject = 'Reset Your Rabs Data Password';
  const nameGreeting = userName ? `Hello ${userName},` : 'Hello,';

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
    <p>${nameGreeting}</p>
    <p>We received a request to reset the password for your Rabs Data account. Click the button below to choose a new password:</p>
    <p style="text-align: center;">
      <a href="${resetUrl}" class="btn" target="_blank" rel="noopener noreferrer">Reset My Password</a>
    </p>
    <p style="font-size: 14px; color: #475569;">
      Or copy and paste this link into your browser:<br>
      <a href="${resetUrl}" class="link">${resetUrl}</a>
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

  if (!mailer) {
    if (!env.isProduction) {
      console.log(`[EmailService DEV] Password reset link for ${to}: ${resetUrl}`);
    } else {
      console.warn('[EmailService] SMTP credentials not configured in production. Password reset email could not be sent.');
    }
    return { sent: false, reason: 'smtp_not_configured' };
  }

  try {
    await mailer.sendMail({
      from: env.email.from,
      to,
      subject,
      text: textContent,
      html: htmlContent,
    });
    return { sent: true };
  } catch (error) {
    console.error('[EmailService] Error sending password reset email:', error.message);
    return { sent: false, reason: error.message };
  }
}
