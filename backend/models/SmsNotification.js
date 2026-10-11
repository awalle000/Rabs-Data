import mongoose from 'mongoose';

const smsNotificationSchema = new mongoose.Schema({
  eventKey: { type: String, required: true, unique: true, maxlength: 180 },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
  phone: { type: String, required: true, select: false },
  message: { type: String, required: true, select: false },
  status: { type: String, enum: ['queued', 'sending', 'accepted', 'failed', 'unknown', 'suppressed'], default: 'queued', index: true },
  attemptCount: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseUntil: { type: Date, default: null },
  providerReference: { type: String, default: null },
  cost: { type: Number, default: null },
  pages: { type: Number, default: null },
  acceptedAt: { type: Date, default: null },
  lastError: { type: String, default: '', maxlength: 120 },
}, { timestamps: true });

smsNotificationSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });

export default mongoose.model('SmsNotification', smsNotificationSchema);