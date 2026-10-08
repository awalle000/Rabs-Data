import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import useAsync from '../../hooks/useAsync.js';
import * as paymentService from '../../services/paymentService.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Loader from '../../components/Loader/Loader.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './Wallet.css';

const PRESETS = [5, 10, 20, 50];

const COLUMNS = [
  { key: 'createdAt', label: 'Date', render: (item) => formatDate(item.createdAt) },
  { key: 'description', label: 'Details', render: (item) => item.description || item.type.replace('_', ' ') },
  {
    key: 'amount',
    label: 'Amount',
    align: 'right',
    render: (item) => (
      <span className={item.direction === 'credit' ? 'wallet__credit' : 'wallet__debit'}>
        {item.direction === 'credit' ? '+' : '-'}
        {formatCurrency(item.amount)}
      </span>
    ),
  },
  { key: 'balanceAfter', label: 'Balance', align: 'right', render: (item) => formatCurrency(item.balanceAfter) },
];

export default function Wallet() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data, loading, error, reload } = useAsync(paymentService.getWallet, []);
  const [amount, setAmount] = useState('');
  const [fundError, setFundError] = useState('');
  const [funding, setFunding] = useState(false);
  const [notice, setNotice] = useState('');

  // Returning from the payment page: ask the backend to verify, then refresh the balance.
  const reference = searchParams.get('reference');
  useEffect(() => {
    if (!reference) return;
    (async () => {
      try {
        const result = await paymentService.verifyPayment(reference);
        setNotice(
          result.payment.status === 'successful'
            ? 'Payment confirmed. Your wallet has been topped up.'
            : 'We have not received a confirmed payment yet. Your balance will update once it is confirmed.'
        );
      } catch {
        setNotice('We could not confirm that payment yet. Your balance will update once it is confirmed.');
      }
      setSearchParams({}, { replace: true });
      reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reference]);

  const handleFund = async (event) => {
    event.preventDefault();
    setFundError('');
    const value = Number(amount);
    if (!(value >= 1 && value <= 5000)) {
      setFundError('Enter an amount between GHS 1 and GHS 5,000.');
      return;
    }

    setFunding(true);
    try {
      const response = await paymentService.fundWallet(value);
      window.location.assign(response.payment.authorizationUrl);
    } catch (err) {
      setFundError(
        getErrorCode(err) === 'PAYMENT_PROVIDER_UNAVAILABLE'
          ? 'Wallet top-up is not available yet because no payment provider is connected.'
          : getErrorMessage(err)
      );
      setFunding(false);
    }
  };

  if (loading && !data) return <Loader fullPage label="Loading your wallet..." />;
  if (error) {
    return (
      <div className="container page">
        <Alert onRetry={reload}>{error}</Alert>
      </div>
    );
  }

  const { wallet, transactions } = data;

  return (
    <div className="container page wallet">
      <h1 className="page__title">Wallet</h1>
      <p className="page__subtitle">Top up once and pay for data instantly.</p>

      {notice && <Alert type="info">{notice}</Alert>}

      <section className="wallet__balance card" aria-label="Wallet balance">
        <span className="muted">Available balance</span>
        <strong className="wallet__amount">{formatCurrency(wallet.balance)}</strong>
      </section>

      {wallet.fundingEnabled ? (
        <form className="card wallet__fund" onSubmit={handleFund} noValidate>
          <h2>Add money</h2>
          <div className="wallet__presets" role="group" aria-label="Quick amounts">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`btn btn--sm ${Number(amount) === preset ? 'btn--primary' : 'btn--ghost'}`}
                onClick={() => setAmount(String(preset))}
              >
                {formatCurrency(preset)}
              </button>
            ))}
          </div>
          <div className="field">
            <label className="field__label" htmlFor="amount">
              Amount (GHS)
            </label>
            <input
              id="amount"
              type="number"
              inputMode="decimal"
              min="1"
              max="5000"
              step="0.01"
              className="field__control"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={fundError ? 'true' : 'false'}
            />
            {fundError && (
              <span className="field__error" role="alert">
                {fundError}
              </span>
            )}
          </div>
          <button type="submit" className="btn btn--primary btn--block" disabled={funding}>
            {funding ? 'Please wait...' : 'Add money'}
          </button>
        </form>
      ) : (
        <Alert type="info">Wallet top-up is currently unavailable.</Alert>
      )}

      <section className="card" aria-labelledby="history-title">
        <h2 id="history-title">History</h2>
        <TransactionTable
          caption="Wallet history"
          columns={COLUMNS}
          rows={transactions}
          emptyTitle="No wallet activity yet"
          emptyMessage="Top-ups, payments and refunds show up here."
        />
      </section>
    </div>
  );
}