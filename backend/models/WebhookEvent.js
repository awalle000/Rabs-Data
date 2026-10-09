import mongoose from 'mongoose';

const webhookEventSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['hubtel', 'remadata'], required: true, index: true },
    providerEventId: { type: String, default: null, index: true },
    reference: { type: String, default: null, index: true },
    eventType: { type: String, default: 'unknown', index: true },
    eventHash: { type: String, required: true, unique: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    payloadSummary: { type: Object, default: {} },
    status: {
      type: String,
      enum: ['received', 'processing', 'processed', 'retryable_failure', 'terminal_failure'],
      default: 'received',
      index: true,
    },
    attemptCount: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    processedAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true }
);

webhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true, sparse: true });

export default mongoose.model('WebhookEvent', webhookEventSchema);
