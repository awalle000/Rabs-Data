import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import env from '../config/environment.js';
import User from '../models/User.js';
import { requestPasswordReset } from '../utils/requestPasswordReset.js';
import { consumePasswordResetToken } from '../utils/passwordResetTokens.js';
import {
  sendPasswordResetEmail,
  sendSmtpMail,
  smtpTimeoutOptions,
  summarizeSmtpError,
  summarizeSmtpInfo,
  verifySmtpTransport,
  sendGoogleAppsScriptEmail,
  validateGoogleAppsScriptConfig,
} from '../services/emailService.js';

const createUser = () => ({
  _id: 'user-reset-test',
  email: 'person@example.com',
  name: '<script>alert(1)</script>',
  isActive: true,
});

const createUserModel = (user) => ({
  findOne: () => ({ select: async () => user }),
  findOneAndUpdate(filter, update) {
    return {
      select: async () => {
        if (!user || (filter.email && user.email !== filter.email)) return null;
        if (filter.passwordResetTokenHash) {
          if (user._id !== filter._id || user.passwordResetTokenHash !== filter.passwordResetTokenHash) return null;
          user.passwordResetTokenHash = undefined;
          user.passwordResetExpiresAt = undefined;
          return user;
        }

        if (!user.isActive) return null;
        const expiredOrMissing = !user.passwordResetTokenHash || !user.passwordResetExpiresAt
          || user.passwordResetExpiresAt <= filter.$or[2].passwordResetExpiresAt.$lte;
        if ((filter._id && user._id !== filter._id) || !user.isActive || !expiredOrMissing) return null;
        Object.assign(user, update.$set);
        return user;
      },
    };
  },
});

test('reset request stores only a token hash and emails an expiring HTTPS link', async () => {
  const user = createUser();
  let message;
  const result = await requestPasswordReset({
    userModel: createUserModel(user),
    email: ' PERSON@example.com ',
    frontendUrl: 'https://rabsdata.example',
    now: () => 1_800_000_000_000,
    sendEmail: async (options) => { message = options; return { outcome: 'accepted' }; },
  });

  const token = message.resetUrl.split('/').at(-1);
  assert.equal(result.outcome, 'accepted');
  assert.match(token, /^[a-f\d]{64}$/);
  assert.equal(user.passwordResetTokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(user.passwordResetTokenHash, token);
  assert.equal(user.passwordResetExpiresAt.getTime(), 1_800_000_000_000 + 15 * 60 * 1000);
  assert.equal(message.resetUrl.startsWith('https://rabsdata.example/reset-password/'), true);
  assert.equal(message.expiresInMinutes, 15);
});

test('concurrent reset retries create one active token and send one email', async () => {
  const user = createUser();
  const userModel = createUserModel(user);
  let sends = 0;
  const request = () => requestPasswordReset({
    userModel,
    email: user.email,
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => {
      sends += 1;
      return { outcome: 'accepted' };
    },
  });

  await Promise.all([request(), request()]);
  assert.equal(sends, 1);
  assert.match(user.passwordResetTokenHash, /^[a-f\d]{64}$/);
});

test('ambiguous delivery retains the token and suppresses duplicate email retries', async () => {
  const user = createUser();
  const userModel = createUserModel(user);
  let sends = 0;
  const request = () => requestPasswordReset({
    userModel,
    email: user.email,
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => {
      sends += 1;
      return { outcome: 'unknown' };
    },
  });

  const first = await request();
  const tokenHash = user.passwordResetTokenHash;
  const retry = await request();
  assert.equal(first.outcome, 'unknown');
  assert.equal(retry.outcome, 'not_issued');
  assert.equal(user.passwordResetTokenHash, tokenHash);
  assert.equal(sends, 1);
});

test('unknown account receives the same generic response without sending email', async () => {
  let sends = 0;
  const result = await requestPasswordReset({
    userModel: createUserModel(null),
    email: 'missing@example.com',
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => { sends += 1; return { outcome: 'accepted' }; },
  });
  assert.equal(result.outcome, 'not_issued');
  assert.equal(sends, 0);
  assert.match(result.message, /If an account exists/);
});

test('invalid, expired, and previously consumed reset tokens are rejected', async () => {
  const now = new Date('2026-10-12T12:00:00.000Z');
  const record = {
    passwordResetTokenHash: 'valid-hash',
    passwordResetExpiresAt: new Date(now.getTime() + 60_000),
    isActive: true,
  };
  const userModel = {
    findOneAndUpdate(filter, update) {
      const valid = record.passwordResetTokenHash === filter.passwordResetTokenHash
        && record.passwordResetExpiresAt > filter.passwordResetExpiresAt.$gt
        && record.isActive === filter.isActive;
      if (valid) {
        record.passwordResetTokenHash = undefined;
        record.passwordResetExpiresAt = undefined;
      }
      return { select: async () => (valid ? { ...record, ...update.$unset } : null) };
    },
  };

  const accepted = await consumePasswordResetToken({ userModel, hashedToken: 'valid-hash', now });
  assert.ok(accepted);
  assert.equal(await consumePasswordResetToken({ userModel, hashedToken: 'valid-hash', now }), null);
  assert.equal(await consumePasswordResetToken({ userModel, hashedToken: 'wrong-hash', now }), null);

  record.passwordResetTokenHash = 'expired-hash';
  record.passwordResetExpiresAt = new Date(now.getTime() - 1);
  assert.equal(await consumePasswordResetToken({ userModel, hashedToken: 'expired-hash', now }), null);
});

test('User model accepts the reset password and rejects the old password', async (t) => {
  const originalInsertOne = User.collection.insertOne;
  const originalUpdateOne = User.collection.updateOne;
  User.collection.insertOne = async (document) => ({ acknowledged: true, insertedId: document._id });
  User.collection.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
  t.after(() => {
    User.collection.insertOne = originalInsertOne;
    User.collection.updateOne = originalUpdateOne;
  });

  const user = new User({
    name: 'Password Reset Test',
    email: 'password-reset-model@example.com',
    phone: '0240000000',
    password: 'OriginalPass123!',
  });
  await user.save();
  assert.equal(await user.comparePassword('OriginalPass123!'), true);

  user.password = 'ResetPassword456!';
  await user.save();
  assert.equal(await user.comparePassword('OriginalPass123!'), false);
  assert.equal(await user.comparePassword('ResetPassword456!'), true);
});

test('confirmed email failure removes the stored reset token', async () => {
  const user = createUser();
  const result = await requestPasswordReset({
    userModel: createUserModel(user),
    email: user.email,
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => ({ outcome: 'failed' }),
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(user.passwordResetTokenHash, undefined);
  assert.equal(user.passwordResetExpiresAt, undefined);
});

test('throwing email delivery is ambiguous and retains the token to prevent duplicates', async () => {
  const user = createUser();
  const result = await requestPasswordReset({
    userModel: createUserModel(user),
    email: user.email,
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => { throw new Error('private transport details'); },
  });
  assert.equal(result.outcome, 'unknown');
  assert.match(user.passwordResetTokenHash, /^[a-f\d]{64}$/);
  assert.ok(user.passwordResetExpiresAt > new Date());
});

test('Resend provider uses HTTPS API and escapes user-controlled HTML', async (t) => {
  const original = {
    provider: env.email.provider,
    apiKey: env.email.resendApiKey,
    from: env.email.from,
    fetch: globalThis.fetch,
  };
  let request;
  env.email.provider = 'resend';
  env.email.resendApiKey = 'test-api-key';
  env.email.from = 'Rabs Data <reset@example.com>';
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response('{}', { status: 200 });
  };
  t.after(() => {
    env.email.provider = original.provider;
    env.email.resendApiKey = original.apiKey;
    env.email.from = original.from;
    globalThis.fetch = original.fetch;
  });

  const result = await sendPasswordResetEmail({
    to: 'person@example.com',
    userName: '<script>alert(1)</script>',
    resetUrl: 'https://rabsdata.example/reset-password/token',
  });
  const payload = JSON.parse(request.options.body);
  assert.equal(result.outcome, 'accepted');
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers.Authorization, 'Bearer test-api-key');
  assert.match(payload.html, /&lt;script&gt;/);
  assert.doesNotMatch(payload.html, /<script>/);
});

test('Resend delivery rejection is reported as failure without exposing provider response', async (t) => {
  const original = {
    provider: env.email.provider,
    apiKey: env.email.resendApiKey,
    from: env.email.from,
    fetch: globalThis.fetch,
    error: console.error,
  };
  let logged = [];
  env.email.provider = 'resend';
  env.email.resendApiKey = 'test-api-key';
  env.email.from = 'Rabs Data <reset@example.com>';
  globalThis.fetch = async () => new Response('secret provider detail', { status: 422 });
  console.error = (...args) => { logged = args; };
  t.after(() => {
    env.email.provider = original.provider;
    env.email.resendApiKey = original.apiKey;
    env.email.from = original.from;
    globalThis.fetch = original.fetch;
    console.error = original.error;
  });

  const result = await sendPasswordResetEmail({
    to: 'person@example.com',
    userName: 'Customer',
    resetUrl: 'https://rabsdata.example/reset-password/token',
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(logged[1].code, 'RESEND_HTTP_422');
  assert.doesNotMatch(JSON.stringify(logged), /secret provider detail|test-api-key/);
});

test('Resend server errors remain ambiguous because delivery may already have been accepted', async (t) => {
  const original = {
    provider: env.email.provider,
    apiKey: env.email.resendApiKey,
    from: env.email.from,
    fetch: globalThis.fetch,
  };
  env.email.provider = 'resend';
  env.email.resendApiKey = 'test-api-key';
  env.email.from = 'Rabs Data <reset@example.com>';
  globalThis.fetch = async () => new Response('provider unavailable', { status: 500 });
  t.after(() => {
    env.email.provider = original.provider;
    env.email.resendApiKey = original.apiKey;
    env.email.from = original.from;
    globalThis.fetch = original.fetch;
  });

  const result = await sendPasswordResetEmail({
    to: 'person@example.com',
    userName: 'Customer',
    resetUrl: 'https://rabsdata.example/reset-password/token',
  });
  assert.equal(result.outcome, 'unknown');
});

test('Apps Script config requires an HTTPS deployed /exec URL and a non-whitespace secret', () => {
  assert.deepEqual(validateGoogleAppsScriptConfig({
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'shared-secret',
  }), { missingVariables: [], invalidVariables: [], endpointValid: true });
  assert.deepEqual(validateGoogleAppsScriptConfig({
    url: 'http://script.google.com/macros/s/deployment-id/exec',
    secret: ' shared-secret ',
  }), {
    missingVariables: [],
    invalidVariables: ['GOOGLE_APPS_SCRIPT_SECRET', 'GOOGLE_APPS_SCRIPT_URL'],
    endpointValid: false,
  });
});

test('Apps Script sends the exact JSON contract and recognizes ok:true without logging secrets', async () => {
  let request;
  const logs = [];
  const originalInfo = console.info;
  console.info = (...args) => logs.push(args);
  try {
    const result = await sendGoogleAppsScriptEmail({
      url: 'https://script.google.com/macros/s/deployment-id/exec',
      secret: 'server-shared-secret',
      to: 'customer@example.com',
      subject: 'Password reset',
      textBody: 'Reset instructions',
      htmlBody: '<p>Reset instructions</p>',
      requestId: 'gas-success-request',
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(result.outcome, 'accepted');
    assert.equal(request.url, 'https://script.google.com/macros/s/deployment-id/exec');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {
      secret: 'server-shared-secret',
      to: 'customer@example.com',
      subject: 'Password reset',
      textBody: 'Reset instructions',
      htmlBody: '<p>Reset instructions</p>',
    });
    assert.equal(request.options.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify(logs), /server-shared-secret|customer@example\.com|deployment-id|Reset instructions/);
    assert.match(JSON.stringify(logs), /gas-success-request/);
  } finally {
    console.info = originalInfo;
  }
});

test('Apps Script ok:false over HTTP 200 is rejected and logs safe response metadata', async () => {
  let logged;
  const originalError = console.error;
  console.error = (...args) => { logged = args; };
  try {
    const result = await sendGoogleAppsScriptEmail({
      url: 'https://script.google.com/macros/s/deployment-id/exec',
      secret: 'server-shared-secret',
      to: 'customer@example.com',
      subject: 'Password reset',
      textBody: 'text',
      htmlBody: '<p>html</p>',
      requestId: 'gas-rejected-request',
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        status: 'unauthorized',
        code: 'invalid_secret',
        error: 'private script detail',
      }), { status: 200 }),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(logged[1].code, 'GOOGLE_APPS_SCRIPT_REJECTED');
    assert.equal(logged[1].requestId, 'gas-rejected-request');
    assert.equal(logged[1].httpStatus, 200);
    assert.equal(logged[1].hasOkField, true);
    assert.equal(logged[1].hasStatusField, true);
    assert.equal(logged[1].hasCodeField, true);
    assert.equal(logged[1].scriptStatus, 'unauthorized');
    assert.equal(logged[1].scriptCode, 'invalid_secret');
    assert.doesNotMatch(JSON.stringify(logged), /server-shared-secret|customer@example\.com|private script detail/);
  } finally {
    console.error = originalError;
  }
});

test('Apps Script unexpected JSON fields are not treated as success and only field presence is logged', async () => {
  let logged;
  const originalWarn = console.warn;
  console.warn = (...args) => { logged = args; };
  try {
    const result = await sendGoogleAppsScriptEmail({
      url: 'https://script.google.com/macros/s/deployment-id/exec',
      secret: 'server-shared-secret',
      to: 'customer@example.com',
      subject: 'Password reset',
      textBody: 'text',
      htmlBody: '<p>html</p>',
      fetchImpl: async () => new Response(JSON.stringify({
        success: true,
        status: 'unexpected-private-value',
        code: 'private-script-code-with-details',
      }), { status: 200 }),
    });
    assert.equal(result.outcome, 'unknown');
    assert.equal(logged[1].code, 'GOOGLE_APPS_SCRIPT_INVALID_RESPONSE');
    assert.equal(logged[1].hasOkField, false);
    assert.equal(logged[1].hasStatusField, true);
    assert.equal(logged[1].hasCodeField, true);
    assert.equal(logged[1].scriptStatus, undefined);
    assert.equal(logged[1].scriptCode, undefined);
    assert.doesNotMatch(JSON.stringify(logged), /unexpected-private-value|private-script-code-with-details|server-shared-secret|customer@example\.com/);
  } finally {
    console.warn = originalWarn;
  }
});

test('Apps Script HTTP errors, malformed responses, and request failures remain ambiguous', async () => {
  const base = {
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'server-shared-secret',
    to: 'customer@example.com',
    subject: 'Password reset',
    textBody: 'text',
    htmlBody: '<p>html</p>',
    requestId: 'gas-ambiguous-request',
  };

  const httpError = await sendGoogleAppsScriptEmail({
    ...base,
    fetchImpl: async () => new Response('server error', { status: 500 }),
  });
  const malformed = await sendGoogleAppsScriptEmail({
    ...base,
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  const networkError = await sendGoogleAppsScriptEmail({
    ...base,
    fetchImpl: async () => { throw new TypeError('network unavailable'); },
  });
  const timeout = await sendGoogleAppsScriptEmail({
    ...base,
    fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
  });

  assert.equal(httpError.outcome, 'unknown');
  assert.equal(malformed.outcome, 'unknown');
  assert.equal(networkError.outcome, 'unknown');
  assert.equal(timeout.outcome, 'unknown');
});

test('ambiguous Apps Script timeout retains token and suppresses duplicate requests', async () => {
  const user = createUser();
  const userModel = createUserModel(user);
  let sends = 0;
  const request = () => requestPasswordReset({
    userModel,
    email: user.email,
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => {
      sends += 1;
      return sendGoogleAppsScriptEmail({
        url: 'https://script.google.com/macros/s/deployment-id/exec',
        secret: 'server-shared-secret',
        to: user.email,
        subject: 'Password reset',
        textBody: 'text',
        htmlBody: '<p>html</p>',
        fetchImpl: async () => { throw new DOMException('timed out', 'TimeoutError'); },
      });
    },
  });

  const first = await request();
  const activeHash = user.passwordResetTokenHash;
  const second = await request();
  assert.equal(first.outcome, 'unknown');
  assert.equal(second.outcome, 'not_issued');
  assert.equal(user.passwordResetTokenHash, activeHash);
  assert.equal(sends, 1);
});

test('startup checks Apps Script configuration and skips SMTP verification', async (t) => {
  const original = {
    provider: env.email.provider,
    config: env.email.googleAppsScript,
    info: console.info,
    warn: console.warn,
  };
  const logs = [];
  env.email.provider = 'google-apps-script';
  env.email.googleAppsScript = {
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'server-shared-secret',
  };
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  t.after(() => {
    env.email.provider = original.provider;
    env.email.googleAppsScript = original.config;
    console.info = original.info;
    console.warn = original.warn;
  });

  assert.deepEqual(await verifySmtpTransport(), { outcome: 'ready' });
  assert.equal(logs.some((entry) => entry[1]?.provider === 'google-apps-script' && entry[1]?.outcome === 'ready'), true);
  assert.doesNotMatch(JSON.stringify(logs), /server-shared-secret|deployment-id/);
});

test('database lookup failure rejects before token creation or email delivery', async () => {
  let sends = 0;
  await assert.rejects(
    requestPasswordReset({
      userModel: { findOneAndUpdate: async () => { throw new Error('database unavailable'); } },
      email: 'person@example.com',
      frontendUrl: 'https://rabsdata.example',
      sendEmail: async () => { sends += 1; return { outcome: 'accepted' }; },
    }),
    /Password reset request could not be processed/
  );
  assert.equal(sends, 0);
});

test('SMTP overall timeout closes the stuck transport', async () => {
  let closed = false;
  const mailer = {
    sendMail: () => new Promise(() => {}),
    close: () => { closed = true; },
  };
  await assert.rejects(sendSmtpMail(mailer, {}, 10), { code: 'ETIMEDOUT' });
  assert.equal(closed, true);
});

test('SMTP success, authentication rejection, and delivery rejection settle promptly', async () => {
  const success = await sendSmtpMail({ sendMail: async () => ({ accepted: ['person@example.com'] }) }, {});
  assert.deepEqual(success.accepted, ['person@example.com']);

  await assert.rejects(
    sendSmtpMail({ sendMail: async () => { throw Object.assign(new Error('private auth details'), { code: 'EAUTH' }); } }, {}),
    { code: 'EAUTH' }
  );
  await assert.rejects(
    sendSmtpMail({ sendMail: async () => { throw Object.assign(new Error('private delivery details'), { code: 'EENVELOPE' }); } }, {}),
    { code: 'EENVELOPE' }
  );
});

test('SMTP transport has bounded connect, greeting, and socket timeouts', () => {
  assert.deepEqual(smtpTimeoutOptions, {
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  });
});

test('startup reports Resend readiness without attempting SMTP verification', async (t) => {
  const original = {
    provider: env.email.provider,
    apiKey: env.email.resendApiKey,
    from: env.email.from,
  };
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const logs = [];
  env.email.provider = 'resend';
  env.email.resendApiKey = 'test-api-key';
  env.email.from = 'Rabs Data <reset@example.com>';
  console.info = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  t.after(() => {
    env.email.provider = original.provider;
    env.email.resendApiKey = original.apiKey;
    env.email.from = original.from;
    console.info = originalInfo;
    console.warn = originalWarn;
  });

  assert.deepEqual(await verifySmtpTransport(), { outcome: 'ready' });
  assert.equal(logs[0][1].provider, 'resend');
  assert.equal(logs[1][1].provider, 'resend');
  assert.equal(logs[1][1].outcome, 'ready');
});

test('Gmail SMTP transport uses implicit TLS and reports Nodemailer delivery counts', async (t) => {
  const original = {
    provider: env.email.provider,
    from: env.email.from,
    smtp: { ...env.email.smtp },
    createTransport: nodemailer.createTransport,
    info: console.info,
  };
  let transportOptions;
  let resultInfo;
  let sendFailure;
  let safeResultLog;
  const capturedLogs = [];
  env.email.provider = 'smtp';
  env.email.from = 'Rabs Data <sender@example.com>';
  Object.assign(env.email.smtp, {
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    user: 'sender@example.com',
    pass: 'test-app-password',
  });
  nodemailer.createTransport = (options) => {
    transportOptions = options;
    return {
      sendMail: async () => {
        if (sendFailure) throw sendFailure;
        return resultInfo;
      },
      verify: async () => true,
    };
  };
  console.info = (...args) => {
    capturedLogs.push(args);
    if (args[0] === '[EmailService] Password-reset SMTP result.') safeResultLog = args[1];
  };
  t.after(() => {
    env.email.provider = original.provider;
    env.email.from = original.from;
    Object.assign(env.email.smtp, original.smtp);
    nodemailer.createTransport = original.createTransport;
    console.info = original.info;
  });

  resultInfo = { accepted: ['recipient@example.com'], rejected: [], messageId: 'smtp-accepted-id' };
  const accepted = await sendPasswordResetEmail({
    to: 'recipient@example.com', userName: 'Customer',
    resetUrl: 'https://rabsdata.example/reset-password/token', requestId: 'request-accepted',
  });
  assert.equal(accepted.outcome, 'accepted');
  assert.deepEqual(await verifySmtpTransport(), { outcome: 'verified' });
  assert.equal(transportOptions.host, 'smtp.gmail.com');
  assert.equal(transportOptions.port, 465);
  assert.equal(transportOptions.secure, true);
  assert.equal(transportOptions.auth.user, 'sender@example.com');
  assert.equal(transportOptions.auth.pass, 'test-app-password');
  assert.deepEqual(transportOptions, { host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: 'sender@example.com', pass: 'test-app-password' }, ...smtpTimeoutOptions });
  assert.deepEqual({ acceptedCount: safeResultLog.acceptedCount, rejectedCount: safeResultLog.rejectedCount, messageId: safeResultLog.messageId }, {
    acceptedCount: 1, rejectedCount: 0, messageId: 'smtp-accepted-id',
  });
  assert.doesNotMatch(JSON.stringify(capturedLogs), /recipient@example\.com|sender@example\.com|test-app-password|reset-password\/token/);
  assert.match(JSON.stringify(capturedLogs), /request-accepted/);

  resultInfo = { accepted: [], rejected: ['recipient@example.com'], messageId: 'smtp-rejected-id' };
  const rejected = await sendPasswordResetEmail({
    to: 'recipient@example.com', userName: 'Customer',
    resetUrl: 'https://rabsdata.example/reset-password/token', requestId: 'request-rejected',
  });
  assert.equal(rejected.outcome, 'failed');
  assert.equal(safeResultLog.acceptedCount, 0);
  assert.equal(safeResultLog.rejectedCount, 1);

  for (const [failure, requestId, stage, code] of [
    [Object.assign(new Error('private authentication detail'), { code: 'EAUTH' }), 'request-auth', 'authentication', 'SMTP_AUTH_FAILED'],
    [Object.assign(new Error('private connection detail'), { code: 'ECONNECTION' }), 'request-connection', 'connection', 'ECONNECTION'],
  ]) {
    sendFailure = failure;
    const failed = await sendPasswordResetEmail({
      to: 'recipient@example.com', userName: 'Customer',
      resetUrl: 'https://rabsdata.example/reset-password/secret-token', requestId,
    });
    assert.equal(failed.outcome, 'failed');
    assert.equal(safeResultLog.requestId, requestId);
    assert.equal(safeResultLog.stage, stage);
    assert.equal(safeResultLog.code, code);
    assert.doesNotMatch(JSON.stringify(safeResultLog), /private authentication detail|private connection detail|test-app-password|recipient@example.com|secret-token/);
  }
});

test('SMTP outcomes distinguish auth, connection, recipient rejection, and ambiguous timeout', () => {
  assert.deepEqual(summarizeSmtpError({ code: 'EAUTH' }), {
    outcome: 'failed', stage: 'authentication', code: 'SMTP_AUTH_FAILED',
  });
  assert.deepEqual(summarizeSmtpError({ code: 'ECONNECTION' }), {
    outcome: 'failed', stage: 'connection', code: 'ECONNECTION',
  });
  assert.deepEqual(summarizeSmtpError({ code: 'EENVELOPE', command: 'RCPT TO' }), {
    outcome: 'failed', stage: 'recipient', code: 'EENVELOPE',
  });
  assert.deepEqual(summarizeSmtpError({ code: 'ETIMEDOUT', command: 'OVERALL_SEND' }), {
    outcome: 'unknown', stage: 'delivery', code: 'SMTP_TIMEOUT',
  });
  assert.deepEqual(summarizeSmtpError({ code: 'ETIMEDOUT', command: 'CONN' }), {
    outcome: 'failed', stage: 'connection', code: 'SMTP_TIMEOUT',
  });
  assert.deepEqual(summarizeSmtpError({ code: 'ESOCKET', command: 'DATA' }), {
    outcome: 'unknown', stage: 'delivery', code: 'SMTP_ERROR',
  });
  assert.deepEqual(summarizeSmtpInfo({ accepted: [], rejected: ['person@example.com'], messageId: 'smtp-id' }), {
    outcome: 'failed', acceptedCount: 0, rejectedCount: 1, messageId: 'smtp-id',
  });
  assert.deepEqual(summarizeSmtpInfo({ accepted: ['person@example.com'], rejected: [], messageId: 'smtp-id' }), {
    outcome: 'accepted', acceptedCount: 1, rejectedCount: 0, messageId: 'smtp-id',
  });
});

test('Apps Script authentication rejection is handled as a confirmed failure', async () => {
  const result = await sendGoogleAppsScriptEmail({
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'server-shared-secret',
    to: 'customer@example.com',
    subject: 'Password reset',
    textBody: 'text',
    htmlBody: '<p>html</p>',
    fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 200 }),
  });
  assert.equal(result.outcome, 'failed');
});

test('startup reports incomplete Resend configuration without exposing provider values', async (t) => {
  const original = {
    provider: env.email.provider,
    apiKey: env.email.resendApiKey,
    from: env.email.from,
    info: console.info,
  };
  const logs = [];
  env.email.provider = 'resend';
  env.email.resendApiKey = '';
  env.email.from = '';
  console.info = (...args) => logs.push(args);
  t.after(() => {
    env.email.provider = original.provider;
    env.email.resendApiKey = original.apiKey;
    env.email.from = original.from;
    console.info = original.info;
  });

  assert.deepEqual(await verifySmtpTransport(), { outcome: 'failed' });
  assert.equal(logs.some((entry) => entry[1]?.missingVariables?.includes('RESEND_API_KEY')), true);
  assert.doesNotMatch(JSON.stringify(logs), /server-shared-secret|deployment-id/);
});

test('Apps Script password-reset delivery sends the configured Vercel link with the stored token hash', async (t) => {
  const original = {
    provider: env.email.provider,
    config: env.email.googleAppsScript,
    fetch: globalThis.fetch,
  };
  let request;
  env.email.provider = 'google-apps-script';
  env.email.googleAppsScript = {
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'server-shared-secret',
  };
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  t.after(() => {
    env.email.provider = original.provider;
    env.email.googleAppsScript = original.config;
    globalThis.fetch = original.fetch;
  });

  const user = createUser();
  const result = await requestPasswordReset({
    userModel: createUserModel(user),
    email: user.email,
    frontendUrl: 'https://rabs-data.vercel.app',
    sendEmail: sendPasswordResetEmail,
  });
  const payload = JSON.parse(request.options.body);
  const resetUrl = payload.textBody.match(/https:\/\/rabs-data\.vercel\.app\/reset-password\/[a-f\d]{64}/)?.[0];
  const rawToken = resetUrl?.split('/').at(-1);

  assert.equal(result.outcome, 'accepted');
  assert.ok(resetUrl);
  assert.equal(user.passwordResetTokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'));
  assert.equal(payload.to, user.email);
  assert.equal(payload.htmlBody.includes(resetUrl), true);
});

test('Apps Script valid JSON null remains an invalid response without throwing', async () => {
  const result = await sendGoogleAppsScriptEmail({
    url: 'https://script.google.com/macros/s/deployment-id/exec',
    secret: 'server-shared-secret',
    to: 'customer@example.com',
    subject: 'Password reset',
    textBody: 'text',
    htmlBody: '<p>html</p>',
    fetchImpl: async () => new Response('null', { status: 200 }),
  });
  assert.equal(result.outcome, 'unknown');
});
