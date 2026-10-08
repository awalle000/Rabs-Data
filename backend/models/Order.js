import mongoose from 'mongoose';
import { NETWORK_CODES } from '../config/networks.js';
import { generateTrackingToken } from '../utils/tokens.js';

export const ORDER_STATUSES = [
  'pending',
  'payment_pending',
  'paid',
  'processing',
  'successful',
  'failed',
  'refunded',
];

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    // Optional: guests buy without an account.
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    contactPhone: { type: String, index: true },
    contactEmail: { type: String, trim: true, lowercase: true },
    // Secret that lets a guest view and pay for their own order.
    trackingToken: { type: String, default: generateTrackingToken, select: false },
    network: { type: String, enum: NETWORK_CODES, required: true },
    dataPackage: { type: mongoose.Schema.Types.ObjectId, ref: 'DataPackage', required: true },
    // Snapshots, so later price or name edits never change old orders.
    packageName: { type: String, required: true },
    dataAmount: { type: String, required: true },
    validity: { type: String, required: true },
    providerPackageCode: { type: String, default: '' },
    recipientPhone: { type: String, required: true },
    volumeInMB: { type: Number },
    sellingPrice: { type: Number, required: true, min: 0 },
    baseProductPrice: { type: Number, min: 0 },
    customerChargedAmount: { type: Number, min: 0 },
    paymentGatewayFee: { type: Number, default: 0, min: 0 },
    providerCost: { type: Number, required: true, min: 0 },
    profit: { type: Number, required: true },
    grossProfit: { type: Number },
    netProfit: { type: Number },
    // Supplier (RemaData) tracking fields
    supplier: { type: String, default: 'RemaData' },
    supplierCost: { type: Number, min: 0 },
    supplierReference: { type: String, index: true },
    supplierClientReference: { type: String, index: true },
    supplierStatus: {
      type: String,
      enum: ['not_started', 'not_submitted', 'pending', 'completed', 'failed', 'refunded', 'uncertain'],
      default: 'not_started',
      index: true,
    },
    supplierSubmitted: { type: Boolean, default: false },
    supplierSubmittedAt: { type: Date },
    supplierCompletedAt: { type: Date },
    supplierRefunded: { type: Boolean, default: false },
    paymentMethod: { type: String, enum: ['direct', 'wallet'], default: 'direct' },
    paymentReference: { type: String, index: true },
    hubtelReference: { type: String, index: true },
    hubtelTransactionId: { type: String, index: true },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
      index: true,
    },
    providerReference: { type: String, index: true },
    status: { type: String, enum: ORDER_STATUSES, default: 'pending', index: true },
    failureReason: { type: String },
    refundRequired: { type: Boolean, default: false },
    needsReview: { type: Boolean, default: false },
    paidAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

orderSchema.index({ customer: 1, createdAt: -1 });

// Ensure supplierCost mirrors providerCost, supplierReference mirrors providerReference,
// and financial fee accounting fields are populated.
orderSchema.pre('save', function () {
  if (this.supplierCost == null && this.providerCost != null) {
    this.supplierCost = this.providerCost;
  } else if (this.providerCost == null && this.supplierCost != null) {
    this.providerCost = this.supplierCost;
  }
  if (this.baseProductPrice == null && this.sellingPrice != null) {
    this.baseProductPrice = this.sellingPrice;
  }
  if (this.customerChargedAmount == null && this.sellingPrice != null) {
    this.customerChargedAmount = this.sellingPrice;
  }
  if (this.grossProfit == null) {
    const base = Number(this.baseProductPrice ?? this.sellingPrice ?? 0);
    const cost = Number(this.supplierCost ?? this.providerCost ?? 0);
    this.grossProfit = Math.round((base - cost) * 100) / 100;
  }
  if (this.netProfit == null) {
    const gross = Number(this.grossProfit ?? 0);
    const fee = Number(this.paymentGatewayFee ?? 0);
    this.netProfit = Math.round((gross - fee) * 100) / 100;
  }
  if (!this.paymentStatus) {
    if (['paid', 'processing', 'successful'].includes(this.status)) {
      this.paymentStatus = 'paid';
    } else if (this.status === 'failed') {
      this.paymentStatus = 'failed';
    } else if (this.status === 'refunded') {
      this.paymentStatus = 'refunded';
    } else {
      this.paymentStatus = 'pending';
    }
  }
  if (!this.supplierClientReference && this.orderId) {
    this.supplierClientReference = this.orderId;
  }
  if (this.supplierReference && !this.providerReference) {
    this.providerReference = this.supplierReference;
  } else if (this.providerReference && !this.supplierReference) {
    this.supplierReference = this.providerReference;
  }
  if (this.paymentReference && !this.hubtelReference) {
    this.hubtelReference = this.paymentReference;
  } else if (this.hubtelReference && !this.paymentReference) {
    this.paymentReference = this.hubtelReference;
  }
});

// Customers (and guests) must never see provider/supplier cost, profit or internals.
orderSchema.methods.toCustomerJSON = function () {
  const order = this.toObject();
  delete order.providerCost;
  delete order.supplierCost;
  delete order.supplier;
  delete order.supplierReference;
  delete order.supplierClientReference;
  delete order.supplierStatus;
  delete order.supplierSubmitted;
  delete order.supplierSubmittedAt;
  delete order.supplierCompletedAt;
  delete order.supplierRefunded;
  delete order.volumeInMB;
  delete order.profit;
  delete order.grossProfit;
  delete order.netProfit;
  delete order.providerPackageCode;
  delete order.providerReference;
  delete order.refundRequired;
  delete order.needsReview;
  delete order.trackingToken;
  delete order.__v;
  return order;
};

export default mongoose.model('Order', orderSchema);