import mongoose from 'mongoose';

const packageActivationAuditSchema = new mongoose.Schema(
  {
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'DataPackage', required: true, index: true },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    previousActive: { type: Boolean, required: true },
    newActive: { type: Boolean, required: true },
    sourceOperation: {
      type: String,
      enum: ['admin_package_activation', 'admin_package_update', 'admin_delete_deactivation'],
      required: true,
    },
    changedAt: { type: Date, default: Date.now, required: true },
  },
  { versionKey: false }
);

packageActivationAuditSchema.index({ packageId: 1, changedAt: -1 });

export default mongoose.model('PackageActivationAudit', packageActivationAuditSchema);
