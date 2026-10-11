import mongoose from 'mongoose';

const adminPushEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, maxlength: 180 },
  title: { type: String, required: true, maxlength: 120 },
  body: { type: String, required: true, maxlength: 180 },
  url: { type: String, required: true, maxlength: 240 },
  status: { type: String, enum: ['queued', 'sent', 'exhausted'], default: 'queued', index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastAttemptAt: { type: Date, default: null },
}, { timestamps: true });

adminPushEventSchema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.model('AdminPushEvent', adminPushEventSchema);