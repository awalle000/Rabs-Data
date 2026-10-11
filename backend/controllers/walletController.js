import Payment from '../models/Payment.js';
import Transaction from '../models/Transaction.js';
import env from '../config/environment.js';
import * as paymentService from '../services/paymentService.js';
import { getOrCreateWallet } from '../services/walletService.js';
import { generateReference } from '../utils/generateOrderId.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { roundMoney } from '../utils/money.js';

const WALLET_TYPES = ['wallet_funding', 'wallet_debit', 'refund', 'manual_credit'];

export const getWallet = asyncHandler(async (req, res) => {
  const wallet = await getOrCreateWallet(req.user._id);

  const transactions = await Transaction.find({ user: req.user._id, type: { $in: WALLET_TYPES } })
    .sort({ createdAt: -1 })
    .limit(20)
    .select('type direction amount balanceAfter description reference createdAt');

  res.json({
    success: true,
    wallet: {
      balance: roundMoney(wallet.balance),
      currency: wallet.currency,
      fundingEnabled: env.walletEnabled,
    },
    transactions,
  });
});

export const fundWallet = asyncHandler(async (req, res) => {
  if (!env.walletEnabled) throw new AppError('Wallet funding is not available', 400);

  const amount = req.body.amount;
  const email = String(req.user.email || '').trim().toLowerCase();
  if (!email) throw new AppError('A valid email address is required to start a payment.', 400, 'PAYMENT_EMAIL_REQUIRED');
  if (!paymentService.isPaymentConfigured('paystack')) throw new AppError('Online payments are not configured.', 503, 'PAYMENT_PROVIDER_UNAVAILABLE');

  const existingPayment = await Payment.findOne({
    user: req.user._id,
    purpose: 'wallet_funding',
    status: { $in: ['initialized', 'pending'] },
  });
  if (existingPayment) {
    if (existingPayment.authorizationUrl) {
      return res.json({ success: true, duplicate: true, payment: {
        reference: existingPayment.reference, amount: existingPayment.amount,
        currency: existingPayment.currency, authorizationUrl: existingPayment.authorizationUrl,
      } });
    }
    return res.status(202).json({ success: true, pending: true, reference: existingPayment.reference, message: 'The existing top-up is being verified. Do not start another payment.' });
  }

  paymentService.toPesewas(amount);
  const reference = generateReference('DHP');

  // Record the attempt first, so a callback can always find it.
  let payment;
  try {
    payment = await Payment.create({
      reference,
      user: req.user._id,
      contactEmail: email,
      purpose: 'wallet_funding',
      amount,
      currency: 'GHS',
      provider: 'paystack',
      providerMetadata: { rabsPaymentReference: reference, rabsPurpose: 'wallet_funding', rabsOrderId: '', rabsUserId: String(req.user._id) },
      feePassedToCustomer: false,
      paymentGatewayFeeKnown: false,
      walletFundingActive: true,
      initializationState: 'created',
      status: 'initialized',
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const activePayment = await Payment.findOne({ user: req.user._id, purpose: 'wallet_funding', walletFundingActive: true });
    if (activePayment?.authorizationUrl) {
      return res.json({ success: true, duplicate: true, payment: {
        reference: activePayment.reference, amount: activePayment.amount,
        currency: activePayment.currency, authorizationUrl: activePayment.authorizationUrl,
      } });
    }
    return res.status(202).json({ success: true, pending: true, reference: activePayment?.reference, message: 'The existing top-up is being verified. Do not start another payment.' });
  }

  let init;
  try {
    await Payment.updateOne({ _id: payment._id, status: 'initialized' }, { $set: { initializationState: 'in_progress' } });
    init = await paymentService.initializePayment({
      reference,
      amount,
      email,
      description: 'Rabs Data wallet top-up',
      returnUrl: `${env.clientUrl}/wallet?reference=${reference}`,
      cancelUrl: `${env.clientUrl}/wallet`,
      metadata: payment.providerMetadata,
    });
  } catch (error) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { initializationState: 'uncertain', failureReason: 'Paystack initialization outcome is uncertain; verify the stored reference before any retry.' } }
    );
    throw error;
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'pending',
        providerReference: init.providerReference || undefined,
        accessCode: init.accessCode,
        authorizationUrl: init.authorizationUrl,
        initializationState: 'ready',
      },
    }
  );

  res.status(201).json({
    success: true,
    payment: {
      reference,
      amount,
      currency: env.currency,
      authorizationUrl: init.authorizationUrl,
    },
  });
});