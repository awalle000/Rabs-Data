import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { session } from '../utils/storage.js';

const KEY = 'maridata_order_draft';
const EMPTY = { network: '', package: null, recipientPhone: '' };

const OrderDraftContext = createContext(null);

// Remembers what the buyer picked, even across a page refresh.
export function OrderDraftProvider({ children }) {
  const [draft, setDraft] = useState(() => ({ ...EMPTY, ...session.get(KEY, {}) }));

  useEffect(() => {
    session.set(KEY, draft);
  }, [draft]);

  const updateDraft = useCallback((patch) => setDraft((current) => ({ ...current, ...patch })), []);
  const clearDraft = useCallback(() => setDraft(EMPTY), []);

  const value = useMemo(() => ({ draft, updateDraft, clearDraft }), [draft, updateDraft, clearDraft]);

  return <OrderDraftContext.Provider value={value}>{children}</OrderDraftContext.Provider>;
}

export const useOrderDraft = () => {
  const context = useContext(OrderDraftContext);
  if (!context) throw new Error('useOrderDraft must be used inside <OrderDraftProvider>');
  return context;
};