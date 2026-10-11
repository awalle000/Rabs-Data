import Wallet from '../models/Wallet.js';
import Transaction from '../models/Transaction.js';
import AppError from '../utils/AppError.js';
import { roundMoney } from '../utils/money.js';
import crypto from 'node:crypto';

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

export const canDebitWallet = ({ balance, amount }) => {
  const value = roundMoney(amount);
  return Number(balance) >= value - 0.005;
};

const operationKeyFor = ({ userId, type, reference, operationKey }) => operationKey || crypto
  .createHash('sha256')
  .update(`${userId}:${type}:${reference || crypto.randomUUID()}`)
  .digest('hex');

const findOperationTransaction = async (operationKey) => Transaction.findOne({ operationKey }).lean();

const resumePendingWalletOperation = async (userId) => {
  let wallet = await Wallet.findOne({ user: userId });
  const operation = wallet?.pendingOperation;
  if (!operation) return wallet;

  const existingEntry = await findOperationTransaction(operation.key);
  if (existingEntry) {
    await Wallet.updateOne({ user: userId, 'pendingOperation.key': operation.key }, { $set: { pendingOperation: null } });
    return Wallet.findOne({ user: userId });
  }

  if (!operation.applied) {
    const delta = operation.direction === 'credit' ? operation.amount : -operation.amount;
    const filter = {
      user: userId,
      'pendingOperation.key': operation.key,
      'pendingOperation.applied': { $ne: true },
      ...(operation.direction === 'debit' ? { balance: { $gte: operation.amount } } : {}),
    };
    wallet = await Wallet.findOneAndUpdate(
      filter,
      [{
        $set: {
          balance: { $add: ['$balance', delta] },
          'pendingOperation.applied': true,
          'pendingOperation.balanceAfter': { $add: ['$balance', delta] },
        },
      }],
      { returnDocument: 'after' }
    );

    if (!wallet) {
      const latest = await Wallet.findOne({ user: userId });
      if (latest?.pendingOperation?.key === operation.key && latest.pendingOperation.applied) {
        wallet = latest;
      } else if (latest?.pendingOperation?.key === operation.key && operation.direction === 'debit') {
        await Wallet.updateOne({ user: userId, 'pendingOperation.key': operation.key }, { $set: { pendingOperation: null } });
        throw new AppError('Insufficient wallet balance', 402, 'INSUFFICIENT_BALANCE');
      } else {
        return latest;
      }
    }
  }

  const applied = wallet?.pendingOperation || operation;
  try {
    await Transaction.create({
      operationKey: applied.key,
      user: userId,
      order: applied.order,
      payment: applied.payment,
      type: applied.type,
      direction: applied.direction,
      amount: applied.amount,
      balanceAfter: applied.balanceAfter,
      reference: applied.reference,
      description: applied.description,
      metadata: applied.metadata,
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const duplicate = await findOperationTransaction(applied.key);
    if (!duplicate) throw error;
  }

  await Wallet.updateOne({ user: userId, 'pendingOperation.key': applied.key }, { $set: { pendingOperation: null } });
  return Wallet.findOne({ user: userId });
};

const runWalletOperation = async ({
  userId, amount, type, direction, description, reference, orderId, paymentId, metadata, operationKey,
}) => {
  const value = roundMoney(amount);
  if (!(value > 0)) throw new AppError('Invalid amount', 400);
  const key = operationKeyFor({ userId, type, reference, operationKey });
  const existing = await findOperationTransaction(key);
  if (existing) {
    if (existing.type !== type || existing.direction !== direction || Number(existing.amount) !== value) {
      throw new AppError('Wallet operation key was reused with different financial details.', 409, 'WALLET_OPERATION_CONFLICT');
    }
    if (String(existing.user || '') !== String(userId || '')) {
      throw new AppError('Wallet operation key belongs to a different customer.', 409, 'WALLET_OPERATION_FORBIDDEN');
    }
    await Wallet.updateOne({ user: userId, 'pendingOperation.key': key }, { $set: { pendingOperation: null } });
    return Wallet.findOne({ user: userId });
  }

  await getOrCreateWallet(userId);
  const currentWallet = await Wallet.findOne({ user: userId });
  if (currentWallet?.pendingOperation?.key === key) return resumePendingWalletOperation(userId);
  if (currentWallet?.pendingOperation) await resumePendingWalletOperation(userId);
  const intent = {
    key, direction, amount: value, type, description, reference,
    order: orderId || null, payment: paymentId || null, metadata, applied: false,
  };
  const claimed = await Wallet.findOneAndUpdate(
    {
      user: userId,
      $or: [{ pendingOperation: null }, { pendingOperation: { $exists: false } }],
    },
    { $set: { pendingOperation: intent } },
    { returnDocument: 'after' }
  );
  if (claimed?.pendingOperation?.key === key) return resumePendingWalletOperation(userId);
  if (!claimed) {
    await resumePendingWalletOperation(userId);
    const alreadyCompleted = await findOperationTransaction(key);
    if (alreadyCompleted) return Wallet.findOne({ user: userId });
    const retryClaim = await Wallet.findOneAndUpdate(
      {
        user: userId,
        $or: [{ pendingOperation: null }, { pendingOperation: { $exists: false } }],
      },
      { $set: { pendingOperation: intent } },
      { returnDocument: 'after' }
    );
    if (retryClaim?.pendingOperation?.key !== key) throw new AppError('Another wallet update is being recovered. Retry shortly.', 503, 'WALLET_RECOVERY_PENDING');
  }

  return resumePendingWalletOperation(userId);
};

export const recoverPendingWalletOperations = async ({ limit = 50 } = {}) => {
  const wallets = await Wallet.find({ 'pendingOperation.key': { $exists: true } }).limit(limit).lean();
  const results = [];
  for (const wallet of wallets) {
    try {
      await resumePendingWalletOperation(wallet.user);
      results.push({ user: wallet.user, recovered: true });
    } catch (error) {
      results.push({ user: wallet.user, recovered: false, code: error.code || 'WALLET_RECOVERY_FAILED' });
    }
  }
  return results;
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
  operationKey,
}) => {
  return runWalletOperation({
    userId, amount, type, direction: 'credit', description, reference, orderId, paymentId, metadata, operationKey,
  });
};

export const debitWallet = async ({ userId, amount, type, description, reference, orderId, operationKey }) => {
  return runWalletOperation({
    userId, amount, type, direction: 'debit', description, reference, orderId, operationKey,
  });
};