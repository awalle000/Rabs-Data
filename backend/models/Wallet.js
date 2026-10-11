import mongoose from 'mongoose';

const pendingOperationSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    direction: { type: String, enum: ['credit', 'debit'], required: true },
    amount: { type: Number, required: true, min: 0 },
    type: { type: String, required: true },
    description: { type: String, default: '' },
    reference: { type: String, default: null },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    metadata: { type: mongoose.Schema.Types.Mixed },
    applied: { type: Boolean, default: false },
    balanceAfter: { type: Number, default: null },
  },
  { _id: false }
);

const walletSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    balance: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'GHS' },
    pendingOperation: { type: pendingOperationSchema, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('Wallet', walletSchema);