import mongoose from 'mongoose';

const adminNotificationSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true, maxlength: 180 },
    category: { type: String, enum: ['orders', 'payments', 'supplier', 'system'], required: true, index: true },
    type: { type: String, required: true, maxlength: 80 },
    title: { type: String, required: true, maxlength: 120 },
    message: { type: String, required: true, maxlength: 240 },
    priority: { type: String, enum: ['critical', 'important', 'info'], default: 'important', index: true },
    sound: { type: Boolean, default: true },
    link: { type: String, required: true, maxlength: 180 },
    relatedOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    relatedPayment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    relatedPackage: { type: mongoose.Schema.Types.ObjectId, ref: 'DataPackage', default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

adminNotificationSchema.index({ createdAt: -1, _id: -1 });
adminNotificationSchema.index({ category: 1, createdAt: -1 });
adminNotificationSchema.index({ readBy: 1, createdAt: -1 });
adminNotificationSchema.index({ archivedBy: 1, createdAt: -1 });

export default mongoose.model('AdminNotification', adminNotificationSchema);