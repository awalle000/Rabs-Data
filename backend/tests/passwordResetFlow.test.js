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

test('failed or throwing email delivery removes the stored reset token', async () => {
  for (const sendEmail of [async () => ({ outcome: 'failed' }), async () => { throw new Error('private transport details'); }]) {
    const user = createUser();
    const result = await requestPasswordReset({
      userModel: createUserModel(user),
      email: user.email,
      frontendUrl: 'https://rabsdata.example',
      sendEmail,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(user.passwordResetTokenHash, undefined);
    assert.equal(user.passwordResetExpiresAt, undefined);
  }
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