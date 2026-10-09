import mongoose from 'mongoose';

const purchaseOperationSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    kind: {
      type: String,
      enum: ['data_purchase'],
      default: 'data_purchase',
      index: true,
    },
    requestFingerprint: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'created', 'fulfilled', 'failed', 'conflict', 'cancelled'],
      default: 'pending',
      index: true,
    },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    paymentReference: { type: String, default: null, index: true },
    supplierReference: { type: String, default: null, index: true },
    payloadSnapshot: { type: Object, default: {} },
    lastKnownState: { type: Object, default: {} },
    expiresAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

purchaseOperationSchema.index({ customer: 1, key: 1 }, { unique: true });

export default mongoose.model('PurchaseOperation', purchaseOperationSchema);
