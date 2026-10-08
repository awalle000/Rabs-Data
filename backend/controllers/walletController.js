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
  const reference = generateReference('DHW');

  // Record the attempt first, so a callback can always find it.
  const payment = await Payment.create({
    reference,
    user: req.user._id,
    purpose: 'wallet_funding',
    amount,
    currency: env.currency,
    provider: env.payment.provider,
    status: 'initialized',
  });

  let init;
  try {
    init = await paymentService.initializePayment({
      reference,
      amount,
      description: 'Rabs Data wallet top-up',
      returnUrl: `${env.clientUrl}/wallet?reference=${reference}`,
      cancelUrl: `${env.clientUrl}/wallet`,
    });
  } catch (error) {
    await Payment.updateOne(
      { _id: payment._id },
      { $set: { status: 'failed', failureReason: 'Could not start payment' } }
    );
    throw error;
  }

  await Payment.updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'pending',
        providerReference: init.providerReference,
        authorizationUrl: init.authorizationUrl,
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