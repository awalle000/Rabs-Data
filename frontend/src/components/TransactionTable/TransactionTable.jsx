import Loader from '../Loader/Loader.jsx';
import EmptyState from '../EmptyState/EmptyState.jsx';
import './TransactionTable.css';

// columns: [{ key, label, render?(row), align? }]. On phones, rows become stacked cards.
export default function TransactionTable({
  caption,
  columns,
  rows = [],
  rowKey = (row) => row._id,
  onRowClick,
  loading = false,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  emptyAction,
}) {
  if (loading) return <Loader label="Loading..." />;
  if (!rows.length) {
    return <EmptyState title={emptyTitle} message={emptyMessage} action={emptyAction} />;
  }

  return (
    <div className="tx-table__wrap">
      <table className="tx-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align ? `tx-table__${column.align}` : ''}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? 'tx-table__row--clickable' : ''}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter') onRowClick(row);
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-label={column.label}
                  className={column.align ? `tx-table__${column.align}` : ''}
                >
                  {column.render ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}