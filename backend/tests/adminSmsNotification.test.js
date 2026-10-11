import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/rabsdata-test';
process.env.JWT_SECRET = 'admin-sms-test-secret-with-more-than-32-characters';

const [{ default: SmsNotification }, { listAdminSmsNotifications }] = await Promise.all([
  import('../models/SmsNotification.js'),
  import('../controllers/adminSmsController.js'),
]);

test('admin SMS log returns delivery metadata and a masked phone, never the message or full number', async () => {
  const originalFind = SmsNotification.find;
  let selectedFields = '';
  SmsNotification.find = () => ({
    sort() { return this; },
    limit() { return this; },
    select(fields) { selectedFields = fields; return this; },
    lean: async () => [{
      _id: 'sms-1', eventKey: 'order-delivered:order-1', order: 'order-1', phone: '0241234567',
      message: 'private message', status: 'accepted', attemptCount: 1,
      providerReference: 'SMS-API-test', cost: 0.1, pages: 1, lastError: '',
    }],
  });

  try {
    let response;
    let caught;
    await listAdminSmsNotifications({ query: { limit: '10' } }, { json(body) { response = body; } }, (error) => { caught = error; });
    if (caught) throw caught;
    assert.equal(selectedFields.includes('message'), false);
    assert.equal(response.notifications[0].phone, '024****567');
    assert.equal(response.notifications[0].status, 'accepted');
    assert.equal(JSON.stringify(response).includes('private message'), false);
    assert.equal(JSON.stringify(response).includes('0241234567'), false);
  } finally {
    SmsNotification.find = originalFind;
  }
});