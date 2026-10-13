import mongoose from 'mongoose';
import { NETWORK_CODES } from '../config/networks.js';
import { roundMoney } from '../utils/money.js';

const dataPackageSchema = new mongoose.Schema(
  {
    network: { type: String, enum: NETWORK_CODES, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    dataAmount: { type: String, required: true, trim: true },
    validity: { type: String, required: true, trim: true },
    bundleType: { type: String, trim: true, default: '' },
    restrictions: { type: [String], default: null },
    providerCost: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    volumeInMB: { type: Number, min: 1 },
    // The code the data provider uses for this bundle. Filled in once the provider is integrated.
    providerPackageCode: { type: String, trim: true, default: '' },
    providerPlanId: { type: String, trim: true, default: '' },
    supplierOffers: {
      padodatagh: {
        packageCode: { type: String, trim: true, default: '' },
        planId: { type: String, trim: true, default: '' },
        supplierCost: { type: Number, min: 0, default: null },
        network: { type: String, default: '' },
        volumeInMB: { type: Number, min: 1, default: null },
        validity: { type: String, default: '' },
        lastVerifiedAt: { type: Date, default: null },
        bundleType: { type: String, default: '' },
        restrictions: { type: [String], default: null },
        hasUnstructuredConditions: { type: Boolean, default: false },
        hasValidityConflict: { type: Boolean, default: false },
        catalogVerified: { type: Boolean, default: false },
      },
      remadata: {
        packageCode: { type: String, trim: true, default: '' },
        supplierCost: { type: Number, min: 0, default: null },
        network: { type: String, default: '' },
        volumeInMB: { type: Number, min: 1, default: null },
        validity: { type: String, default: '' },
        lastVerifiedAt: { type: Date, default: null },
        bundleType: { type: String, default: '' },
        restrictions: { type: [String], default: null },
      },
    },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

dataPackageSchema.virtual('profit').get(function () {
  return roundMoney(this.sellingPrice - this.providerCost);
});

dataPackageSchema.index({ network: 1, name: 1 }, { unique: true });
dataPackageSchema.index({ isActive: 1, network: 1, sellingPrice: 1 });

export default mongoose.model('DataPackage', dataPackageSchema);