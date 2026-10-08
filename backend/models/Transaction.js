import mongoose from 'mongoose';

export const TRANSACTION_TYPES = [
  'wallet_funding',
  'wallet_debit',
  'order_payment',
  'provider_purchase',
  'refund',
  'manual_credit',
  'payment_issue',
];

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
    type: { type: String, enum: TRANSACTION_TYPES, required: true, index: true },
    direction: { type: String, enum: ['credit', 'debit', 'info'], required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number },
    status: { type: String, enum: ['pending', 'successful', 'failed'], default: 'successful' },
    reference: { type: String, index: true },
    providerReference: { type: String },
    description: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

// Compound indexes for user-scoped queries (wallet history, order ledger)
transactionSchema.index({ user: 1, type: 1, createdAt: -1 });
transactionSchema.index({ user: 1, order: 1, createdAt: -1 });

export default mongoose.model('Transaction', transactionSchema);