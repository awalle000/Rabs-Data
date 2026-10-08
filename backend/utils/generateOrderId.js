import crypto from 'crypto';
import Counter from '../models/Counter.js';

const pad = (value, width) => String(value).padStart(width, '0');

// Produces DH-YYYYMMDD-000001. The counter is atomic, so IDs never collide.
export const generateOrderId = async () => {
  const now = new Date();
  const day = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: `order-${day}` },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  );

  return `DH-${day}-${pad(counter.seq, 6)}`;
};

export const generateReference = (prefix) =>
  `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;