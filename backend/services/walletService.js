import Wallet from '../models/Wallet.js';
import Transaction from '../models/Transaction.js';
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/money.js';

export const getOrCreateWallet = async (userId) => {
  try {
    return await Wallet.findOneAndUpdate(
      { user: userId },
      { $setOnInsert: { user: userId, balance: 0 } },
      { returnDocument: 'after', upsert: true }
    );
  } catch (error) {
    if (error.code === 11000) return Wallet.findOne({ user: userId });
    throw error;
  }
};

export const creditWallet = async ({
  userId,
  amount,
  type,
  description,
  reference,
  orderId,
  paymentId,
  metadata,
}) => {
  const value = roundMoney(amount);
  if (!(value > 0)) throw new AppError('Invalid amount', 400);

  await getOrCreateWallet(userId);
  const wallet = await Wallet.findOneAndUpdate(
    { user: userId },
    { $inc: { balance: value } },
    { returnDocument: 'after' }
  );

  await Transaction.create({
    user: userId,
    order: orderId,
    payment: paymentId,
    type,
    direction: 'credit',
    amount: value,
    balanceAfter: roundMoney(wallet.balance),
    reference,
    description,
    metadata,
  });

  return wallet;
};

export const debitWallet = async ({ userId, amount, type, description, reference, orderId }) => {
  const value = roundMoney(amount);
  if (!(value > 0)) throw new AppError('Invalid amount', 400);

  // The balance check and the debit happen in one atomic operation, so two
  // simultaneous orders can never spend the same money twice.
  // 0.005 tolerance absorbs floating point residue from earlier 2-decimal sums.
  const wallet = await Wallet.findOneAndUpdate(
    { user: userId, balance: { $gte: value - 0.005 } },
    { $inc: { balance: -value } },
    { returnDocument: 'after' }
  );

  if (!wallet) {
    throw new AppError('Insufficient wallet balance', 402, 'INSUFFICIENT_BALANCE');
  }

  await Transaction.create({
    user: userId,
    order: orderId,
    type,
    direction: 'debit',
    amount: value,
    balanceAfter: roundMoney(Math.max(wallet.balance, 0)),
    reference,
    description,
  });

  return wallet;
};