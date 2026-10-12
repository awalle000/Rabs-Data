import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import env from '../config/environment.js';
import User from '../models/User.js';
import { requestPasswordReset } from '../utils/requestPasswordReset.js';
import { consumePasswordResetToken } from '../utils/passwordResetTokens.js';
import { sendPasswordResetEmail } from '../services/emailService.js';

const createUser = () => ({
  _id: 'user-reset-test',
  email: 'person@example.com',
  name: '<script>alert(1)</script>',
  isActive: true,
  saves: 0,
  async save() { this.saves += 1; },
});

test('reset request stores only a token hash and emails an expiring HTTPS link', async () => {
  const user = createUser();
  let message;
  const result = await requestPasswordReset({
    userModel: { findOne: async (filter) => (filter.email === user.email ? user : null) },
    email: ' PERSON@example.com ',
    frontendUrl: 'https://rabsdata.example',
    now: () => 1_800_000_000_000,
    sendEmail: async (options) => { message = options; return { sent: true }; },
  });

  const token = message.resetUrl.split('/').at(-1);
  assert.equal(result.sent, true);
  assert.match(token, /^[a-f\d]{64}$/);
  assert.equal(user.passwordResetTokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.notEqual(user.passwordResetTokenHash, token);
  assert.equal(user.passwordResetExpiresAt.getTime(), 1_800_000_000_000 + 15 * 60 * 1000);
  assert.equal(message.resetUrl.startsWith('https://rabsdata.example/reset-password/'), true);
  assert.equal(message.expiresInMinutes, 15);
});

test('unknown account receives the same generic response without sending email', async () => {
  let sends = 0;
  const result = await requestPasswordReset({
    userModel: { findOne: async () => null },
    email: 'missing@example.com',
    frontendUrl: 'https://rabsdata.example',
    sendEmail: async () => { sends += 1; return { sent: true }; },
  });
  assert.equal(result.sent, false);
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
  for (const sendEmail of [async () => ({ sent: false }), async () => { throw new Error('private transport details'); }]) {
    const user = createUser();
    const result = await requestPasswordReset({
      userModel: { findOne: async () => user },
      email: user.email,
      frontendUrl: 'https://rabsdata.example',
      sendEmail,
    });
    assert.equal(result.sent, false);
    assert.equal(user.passwordResetTokenHash, undefined);
    assert.equal(user.passwordResetExpiresAt, undefined);
    assert.equal(user.saves, 2);
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
  assert.equal(result.sent, true);
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
  assert.equal(result.sent, false);
  assert.equal(logged[1].code, 'RESEND_HTTP_422');
  assert.doesNotMatch(JSON.stringify(logged), /secret provider detail|test-api-key/);
});