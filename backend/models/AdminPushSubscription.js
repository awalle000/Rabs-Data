import mongoose from 'mongoose';

const adminPushSubscriptionSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  endpoint: { type: String, required: true, unique: true, maxlength: 2048, select: false },
  keys: {
    p256dh: { type: String, required: true, maxlength: 256, select: false },
    auth: { type: String, required: true, maxlength: 256, select: false },
  },
}, { timestamps: true });

adminPushSubscriptionSchema.index({ admin: 1, createdAt: -1 });

export default mongoose.model('AdminPushSubscription', adminPushSubscriptionSchema);