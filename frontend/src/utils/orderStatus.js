export const STATUS_META = {
  pending: { label: 'Pending', tone: 'neutral' },
  payment_pending: { label: 'Awaiting payment', tone: 'warning' },
  paid: { label: 'Payment received', tone: 'info' },
  processing: { label: 'Processing', tone: 'info' },
  successful: { label: 'Successful', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  refunded: { label: 'Refunded', tone: 'neutral' },
};

export const ALL_STATUSES = Object.keys(STATUS_META);
export const isFinalStatus = (status) => ['successful', 'failed', 'refunded'].includes(status);
export const isInProgress = (status) => ['payment_pending', 'paid', 'processing'].includes(status);
export const isPayable = (status) => ['pending', 'payment_pending'].includes(status);