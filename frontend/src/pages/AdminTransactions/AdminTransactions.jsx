import { useState } from 'react';
import useAsync from '../../hooks/useAsync.js';
import { getTransactions } from '../../services/adminService.js';
import { humanize } from '../../utils/adminFormat.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Pagination from '../../components/Pagination/Pagination.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminTransactions.css';

const TYPES = ['wallet_funding', 'wallet_debit', 'order_payment', 'provider_purchase', 'refund', 'manual_credit', 'payment_issue'];

const COLUMNS = [
  { key: 'createdAt', label: 'Date', render: (item) => formatDate(item.createdAt) },
  { key: 'type', label: 'Type', render: (item) => <strong>{humanize(item.type)}</strong> },
  { key: 'user', label: 'User', render: (item) => item.user?.name || 'Guest' },
  { key: 'order', label: 'Order', render: (item) => item.order?.orderId || '-' },
  {
    key: 'amount',
    label: 'Amount',
    align: 'right',
    render: (item) => (
      <span className={item.direction === 'credit' ? 'txs__credit' : item.direction === 'debit' ? 'txs__debit' : ''}>
        {item.direction === 'credit' ? '+' : item.direction === 'debit' ? '-' : ''}
        {formatCurrency(item.amount)}
      </span>
    ),
  },
  { key: 'status', label: 'Status', render: (item) => humanize(item.status) },
  { key: 'reference', label: 'Payment ref.', render: (item) => <span className="txs__ref">{item.reference || '-'}</span> },
  { key: 'providerReference', label: 'Provider ref.', render: (item) => <span className="txs__ref">{item.providerReference || '-'}</span> },
];

export default function AdminTransactions() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');

  const { data, loading, error, reload } = useAsync(
    () => getTransactions({ page, limit: 20, type: type || undefined, search: search || undefined }),
    [page, type, search]
  );

  const handleSearch = (event) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  return (
    <div>
      <form className="filters" onSubmit={handleSearch} role="search">
        <div className="field filters__grow">
          <label className="field__label" htmlFor="txSearch">
            Search by reference
          </label>
          <input
            id="txSearch"
            className="field__control"
            placeholder="Payment or provider reference"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="txType">
            Type
          </label>
          <select
            id="txType"
            className="field__control"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {TYPES.map((item) => (
              <option key={item} value={item}>
                {humanize(item)}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </form>

      {error && <Alert onRetry={reload}>{error}</Alert>}

      {!error && (
        <div className="card">
          <TransactionTable
            caption="Transactions"
            columns={COLUMNS}
            rows={data?.transactions || []}
            loading={loading && !data}
            emptyTitle="No transactions found"
            emptyMessage="Payments, wallet activity and provider purchases are recorded here."
          />
          <Pagination page={page} pages={data?.pagination?.pages} onChange={setPage} />
        </div>
      )}
    </div>
  );
}