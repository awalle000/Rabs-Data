import mongoose from 'mongoose';

const supplierMetricSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    health: { type: String, enum: ['unknown', 'healthy', 'degraded', 'unhealthy'], default: 'unknown' },
    lastHealthCheckAt: { type: Date, default: null },
    lastSuccessfulCheckAt: { type: Date, default: null },
    lastResponseTimeMs: { type: Number, default: null },
    consecutiveFailures: { type: Number, default: 0 },
    counts: {
      checks: { type: Number, default: 0 },
      successes: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      timeouts: { type: Number, default: 0 },
      accepted: { type: Number, default: 0 },
      delivered: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
    },
    balance: { type: Number, default: null },
    balanceCurrency: { type: String, default: 'GHS' },
    balanceCheckedAt: { type: Date, default: null },
    recentEvents: [{
      type: { type: String, enum: ['health', 'accepted', 'delivered', 'failed', 'pending', 'timeout', 'error'] },
      status: { type: String, default: '' },
      message: { type: String, default: '' },
      responseTimeMs: { type: Number, default: null },
      occurredAt: { type: Date, default: Date.now },
    }],
  },
  { _id: false }
);

const supplierControlSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true, index: true },
    primarySupplier: { type: String, enum: ['PadodaTagh'], default: 'PadodaTagh' },
    suppliers: {
      padodatagh: { type: supplierMetricSchema, default: () => ({}) },
      remadata: { type: supplierMetricSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

export default mongoose.model('SupplierControl', supplierControlSchema);