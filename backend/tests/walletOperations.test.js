import test from 'node:test';
import assert from 'node:assert/strict';

const [{ default: Wallet }, { default: Transaction }, walletService] = await Promise.all([
  import('../models/Wallet.js'),
  import('../models/Transaction.js'),
  import('../services/walletService.js'),
]);

test('wallet operation retries and ledger-write recovery apply the balance only once', async () => {
  const original = {
    walletFindOne: Wallet.findOne,
    walletFind: Wallet.find,
    walletFindOneAndUpdate: Wallet.findOneAndUpdate,
    walletUpdateOne: Wallet.updateOne,
    transactionFindOne: Transaction.findOne,
    transactionCreate: Transaction.create,
  };
  const wallet = { user: 'wallet-user', balance: 20, pendingOperation: null };
  const ledger = new Map();
  let failLedgerOnce = true;

  Wallet.findOne = async () => ({ ...wallet, pendingOperation: wallet.pendingOperation && { ...wallet.pendingOperation } });
  Wallet.find = () => ({ limit: () => ({ lean: async () => wallet.pendingOperation ? [{ user: wallet.user }] : [] }) });
  Wallet.findOneAndUpdate = async (filter, update) => {
    if (Array.isArray(update)) {
      const op = wallet.pendingOperation;
      if (!op || op.key !== filter['pendingOperation.key'] || op.applied) return null;
      if (filter.balance && wallet.balance < op.amount) return null;
      wallet.balance += op.direction === 'credit' ? op.amount : -op.amount;
      op.applied = true;
      op.balanceAfter = wallet.balance;
      return { ...wallet, pendingOperation: { ...op } };
    }
    if (update.$setOnInsert?.balance !== undefined) return wallet;
    if (filter['pendingOperation.key']) return null;
    if (wallet.pendingOperation) return null;
    wallet.pendingOperation = { ...update.$set.pendingOperation };
    return { ...wallet, pendingOperation: { ...wallet.pendingOperation } };
  };
  Wallet.updateOne = async (filter, update) => {
    if (wallet.pendingOperation?.key === filter['pendingOperation.key']) {
      wallet.pendingOperation = update.$set.pendingOperation;
    }
    return { modifiedCount: 1 };
  };
  Transaction.findOne = (filter) => ({ lean: async () => ledger.get(filter.operationKey) || null });
  Transaction.create = async (entry) => {
    if (failLedgerOnce) {
      failLedgerOnce = false;
      throw new Error('simulated ledger write interruption');
    }
    if (ledger.has(entry.operationKey)) throw Object.assign(new Error('duplicate ledger operation'), { code: 11000 });
    ledger.set(entry.operationKey, entry);
    return entry;
  };

  try {
    const operation = {
      userId: wallet.user,
      amount: 7,
      type: 'refund',
      description: 'Refund test',
      reference: 'ORDER-REFUND-1',
      operationKey: 'wallet-refund:order-1',
    };
    await assert.rejects(walletService.creditWallet(operation), /simulated ledger write interruption/);
    assert.equal(wallet.balance, 27);
    assert.equal(wallet.pendingOperation.applied, true);
    await walletService.recoverPendingWalletOperations();
    await walletService.creditWallet(operation);
    assert.equal(wallet.balance, 27);
    assert.equal(ledger.size, 1);
    assert.equal(wallet.pendingOperation, null);
  } finally {
    Wallet.findOne = original.walletFindOne;
    Wallet.find = original.walletFind;
    Wallet.findOneAndUpdate = original.walletFindOneAndUpdate;
    Wallet.updateOne = original.walletUpdateOne;
    Transaction.findOne = original.transactionFindOne;
    Transaction.create = original.transactionCreate;
  }
});