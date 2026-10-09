import mongoose from 'mongoose';

const catalogSyncStateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true, trim: true },
    status: {
      type: String,
      enum: ['idle', 'syncing', 'error'],
      default: 'idle',
    },
    lockToken: { type: String, default: null },
    lockUntil: { type: Date, default: null },
    lastStartedAt: { type: Date, default: null },
    lastFinishedAt: { type: Date, default: null },
    lastSuccessfulAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    summary: {
      added: { type: Number, default: 0 },
      updated: { type: Number, default: 0 },
      unavailable: { type: Number, default: 0 },
      deactivated: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

export default mongoose.model('CatalogSyncState', catalogSyncStateSchema);
