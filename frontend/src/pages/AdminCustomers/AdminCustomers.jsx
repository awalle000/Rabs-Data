import { useState } from 'react';
import useAsync from '../../hooks/useAsync.js';
import { creditCustomerWallet, getCustomers } from '../../services/adminService.js';
import { formatCurrency } from '../../utils/formatCurrency.js';
import { formatDate } from '../../utils/formatDate.js';
import { formatPhone } from '../../utils/formatPhone.js';
import { getErrorMessage } from '../../utils/errors.js';
import TransactionTable from '../../components/TransactionTable/TransactionTable.jsx';
import Pagination from '../../components/Pagination/Pagination.jsx';
import Modal from '../../components/Modal/Modal.jsx';
import Alert from '../../components/Alert/Alert.jsx';
import './AdminCustomers.css';

export default function AdminCustomers() {
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState(null);

  const [target, setTarget] = useState(null); // customer being credited
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useAsync(
    () => getCustomers({ page, limit: 15, search: search || undefined }),
    [page, search]
  );

  const openCredit = (customer) => {
    setTarget(customer);
    setAmount('');
    setNote('');
    setFormError('');
  };

  const handleSearch = (event) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleCredit = async (event) => {
    event.preventDefault();
    const value = Number(amount);
    if (!(value >= 1 && value <= 5000)) {
      setFormError('Enter an amount between GHS 1 and GHS 5,000.');
      return;
    }

    setSaving(true);
    setFormError('');
    try {
      const response = await creditCustomerWallet(target._id, { amount: value, note: note.trim() || undefined });
      setNotice({
        type: 'success',
        text: `Credited ${formatCurrency(value)} to ${target.name}. New balance: ${formatCurrency(response.wallet.balance)}.`,
      });
      setTarget(null);
      reload();
    } catch (err) {
      setFormError(getErrorMessage(err));
    }
    setSaving(false);
  };

  const columns = [
    { key: 'name', label: 'Name', render: (customer) => <strong>{customer.name}</strong> },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone', render: (customer) => formatPhone(customer.phone) },
    { key: 'successfulOrders', label: 'Orders', align: 'right' },
    { key: 'totalSpent', label: 'Spent', align: 'right', render: (customer) => formatCurrency(customer.totalSpent) },
    { key: 'createdAt', label: 'Joined', render: (customer) => formatDate(customer.createdAt) },
    {
      key: 'actions',
      label: 'Wallet',
      render: (customer) => (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => openCredit(customer)}>
          Credit wallet
        </button>
      ),
    },
  ];

  return (
    <div>
      {notice && <Alert type={notice.type}>{notice.text}</Alert>}

      <form className="filters" onSubmit={handleSearch} role="search">
        <div className="field filters__grow">
          <label className="field__label" htmlFor="customerSearch">
            Search customers
          </label>
          <input
            id="customerSearch"
            className="field__control"
            placeholder="Name, email or phone"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        </div>
        <button type="submit" className="btn btn--primary">
          Search
        </button>
      </form>

      <p className="muted admin-customers__note">
        Only registered accounts appear here. Guest buyers are visible on the Orders page.
      </p>

      {error && <Alert onRetry={reload}>{error}</Alert>}

      {!error && (
        <div className="card">
          <TransactionTable
            caption="Customers"
            columns={columns}
            rows={data?.customers || []}
            loading={loading && !data}
            emptyTitle="No customers found"
            emptyMessage="Registered customers will appear here."
          />
          <Pagination page={page} pages={data?.pagination?.pages} onChange={setPage} />
        </div>
      )}

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title={`Credit wallet: ${target?.name || ''}`}
        size="sm"
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setTarget(null)}>
              Cancel
            </button>
            <button type="submit" form="credit-form" className="btn btn--primary" disabled={saving}>
              {saving ? 'Saving...' : 'Credit wallet'}
            </button>
          </>
        }
      >
        <form id="credit-form" onSubmit={handleCredit} noValidate>
          <Alert type="warning">Only credit a wallet after you have actually received the money. This adds spendable balance.</Alert>
          {formError && <Alert>{formError}</Alert>}
          <div className="field">
            <label className="field__label" htmlFor="creditAmount">
              Amount (GHS)
            </label>
            <input
              id="creditAmount"
              type="number"
              inputMode="decimal"
              min="1"
              max="5000"
              step="0.01"
              className="field__control"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="creditNote">
              Note (optional)
            </label>
            <input
              id="creditNote"
              className="field__control"
              maxLength={200}
              placeholder="e.g. Cash received"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </form>
      </Modal>
    </div>
  );
}