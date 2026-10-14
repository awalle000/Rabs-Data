import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import env from '../config/environment.js';
import User from '../models/User.js';

const adminId = '64d9e76af742f8ab3f1e29d1';
const otherId = '64d9e76af742f8ab3f1e29d2';
const originalPassword = 'AdminPass123!';
const nextPassword = 'NewAdminPass456!';

async function createAdmin(password = originalPassword) {
  return {
    _id: adminId,
    role: 'admin',
    isActive: true,
    tokenVersion: 0,
    password: await bcrypt.hash(password, 4),
    async comparePassword(candidate) {
      return bcrypt.compare(candidate, this.password);
    },
    async save() {
      this.password = await bcrypt.hash(this.password, 4);
      this.passwordChangedAt = new Date();
      this.tokenVersion += 1;
    },
    toJSON() {
      return { _id: this._id, role: this.role, isActive: this.isActive };
    },
  };
}

async function withApi(t, { authenticated = true, databaseError = false, saveError = false } = {}) {
  const admin = await createAdmin();
  if (saveError) admin.save = async () => { throw new Error('database write failed'); };
  const other = await createAdmin('OtherPass123!');
  other._id = otherId;
  const originalFindById = User.findById;
  const originalFindOne = User.findOne;
  User.findById = (id) => ({
    select: async () => {
      if (databaseError) throw new Error('database unavailable');
      return String(id) === otherId ? other : admin;
    },
  });
  User.findOne = () => ({ select: async () => admin });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const token = jwt.sign({ id: adminId, tokenVersion: 0 }, env.jwtSecret, { expiresIn: '5m' });
  let ip = 1;
  const api = async (body, requestToken = authenticated ? token : null) => {
    const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${ip++}` };
    if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/users/password`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };
  api.port = server.address().port;
  t.after(async () => {
    User.findById = originalFindById;
    User.findOne = originalFindOne;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { api, admin, other, token };
}

const validChange = {
  currentPassword: originalPassword,
  newPassword: nextPassword,
  confirmPassword: nextPassword,
};

test('authenticated administrator changes password and old tokens are invalidated', async (t) => {
  const { api, admin, token } = await withApi(t);
  const { response, payload } = await api(validChange);
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(await bcrypt.compare(nextPassword, admin.password), true);
  assert.equal(await bcrypt.compare(originalPassword, admin.password), false);
  assert.equal('password' in payload, false);

  const relogin = await api({ currentPassword: originalPassword, newPassword: nextPassword, confirmPassword: nextPassword });
  assert.equal(relogin.response.status, 401);
  assert.equal(await bcrypt.compare(nextPassword, admin.password), true);
  const oldLogin = await fetch(`http://127.0.0.1:${api.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: originalPassword }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`http://127.0.0.1:${api.port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: nextPassword }),
  });
  assert.equal(newLogin.status, 200);
  const oldTokenRequest = await fetch(`http://127.0.0.1:${api.port}/api/users/password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(validChange),
  });
  assert.equal(oldTokenRequest.status, 401);
});

test('incorrect current password is rejected without mutation', async (t) => {
  const { api, admin } = await withApi(t);
  const { response } = await api({ ...validChange, currentPassword: 'WrongPass123!' });
  assert.equal(response.status, 400);
  assert.equal(await bcrypt.compare(originalPassword, admin.password), true);
});

test('password confirmation mismatch and weak passwords are rejected', async (t) => {
  const { api, admin } = await withApi(t);
  const mismatch = await api({ ...validChange, confirmPassword: 'DifferentPass456!' });
  assert.equal(mismatch.response.status, 400);
  const weak = await api({ ...validChange, newPassword: 'short', confirmPassword: 'short' });
  assert.equal(weak.response.status, 400);
  assert.equal(await bcrypt.compare(originalPassword, admin.password), true);
});

test('guest requests cannot change a password', async (t) => {
  const { api } = await withApi(t, { authenticated: false });
  const { response } = await api(validChange, null);
  assert.equal(response.status, 401);
});

test('request-supplied identity cannot select another administrator', async (t) => {
  const { api, admin, other } = await withApi(t);
  const { response } = await api({ ...validChange, userId: otherId, id: otherId });
  assert.equal(response.status, 200);
  assert.equal(await bcrypt.compare(nextPassword, admin.password), true);
  assert.equal(await bcrypt.compare('OtherPass123!', other.password), true);
});

test('database errors return failure and never claim success', async (t) => {
  const { api } = await withApi(t, { saveError: true });
  const { response, payload } = await api(validChange);
  assert.equal(response.status, 500);
  assert.equal(payload.success, false);
  assert.notEqual(payload.message, 'Password updated');
});
