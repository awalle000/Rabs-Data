import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import User from '../models/User.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { normalizePhone } from '../utils/validators.js';

const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;

const phone = normalizePhone(ADMIN_PHONE || '');

if (!ADMIN_NAME || !ADMIN_EMAIL || !phone || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('Set ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE (valid Ghana number) and ADMIN_PASSWORD (8+ chars) in backend/.env');
  process.exit(1);
}

await connectDB();

const email = ADMIN_EMAIL.trim().toLowerCase();
const existing = await User.findOne({ email });

if (existing) {
  existing.role = 'admin';
  await existing.save();
  console.log(`Existing user ${email} is now an admin.`);
} else {
  const admin = await User.create({
    name: ADMIN_NAME,
    email,
    phone,
    password: ADMIN_PASSWORD,
    role: 'admin',
  });
  await getOrCreateWallet(admin._id);
  console.log(`Admin ${email} created.`);
}

await mongoose.disconnect();