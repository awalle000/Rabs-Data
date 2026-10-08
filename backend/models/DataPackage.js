import mongoose from 'mongoose';
import { NETWORK_CODES } from '../config/networks.js';
import { roundMoney } from '../utils/money.js';

const dataPackageSchema = new mongoose.Schema(
  {
    network: { type: String, enum: NETWORK_CODES, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    dataAmount: { type: String, required: true, trim: true },
    validity: { type: String, required: true, trim: true },
    providerCost: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    volumeInMB: { type: Number, min: 1 },
    // The code the data provider uses for this bundle. Filled in once the provider is integrated.
    providerPackageCode: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

dataPackageSchema.virtual('profit').get(function () {
  return roundMoney(this.sellingPrice - this.providerCost);
});

dataPackageSchema.index({ network: 1, name: 1 }, { unique: true });

export default mongoose.model('DataPackage', dataPackageSchema);