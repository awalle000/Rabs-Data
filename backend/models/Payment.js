import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema(
  {
    reference: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    contactPhone: { type: String },
    contactEmail: { type: String },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    purpose: { type: String, enum: ['order', 'wallet_funding'], required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'GHS' },
    provider: { type: String, default: 'hubtel' },
    providerReference: { type: String },
    hubtelTransactionId: { type: String, index: true },
    channel: { type: String },
    paymentGatewayFee: { type: Number, default: 0 },
    amountAfterCharges: { type: Number },
    status: {
      type: String,
      enum: ['initialized', 'pending', 'successful', 'failed', 'refunded'],
      default: 'initialized',
      index: true,
    },
    authorizationUrl: { type: String },
    failureReason: { type: String },
    lastCheckedAt: { type: Date },
    verifiedAt: { type: Date },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model('Payment', paymentSchema);