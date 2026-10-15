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
    provider: { type: String, enum: ['hubtel', 'paystack'] },
    providerReference: { type: String },
    accessCode: { type: String },
    hubtelTransactionId: { type: String, index: true },
    providerMetadata: { type: mongoose.Schema.Types.Mixed },
    initializationState: { type: String, enum: ['created', 'in_progress', 'uncertain', 'ready', 'failed'], default: 'created', index: true },
    walletFundingActive: { type: Boolean, default: false },
    channel: { type: String },
    paymentGatewayFee: { type: Number, default: 0 },
    paymentGatewayFeeKnown: { type: Boolean, default: false },
    feePassedToCustomer: { type: Boolean },
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
    orderRecoveryState: { type: String, enum: ['pending', 'processing', 'complete', 'review'], default: undefined },
    orderRecoveryNextAt: { type: Date },
    orderRecoveryLeaseToken: { type: String },
    orderRecoveryLeaseUntil: { type: Date },
    orderRecoveryAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

paymentSchema.index({ user: 1, walletFundingActive: 1 }, { unique: true, partialFilterExpression: { walletFundingActive: true } });
export default mongoose.model('Payment', paymentSchema);