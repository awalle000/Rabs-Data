import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BuyData from './BuyData.jsx';

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  updateDraft: vi.fn(),
  package: {
    _id: 'pkg-mtn-1gb', network: 'MTN', name: 'MTN 1GB', dataAmount: '1GB',
    validity: 'Non-expiry', sellingPrice: 10,
  },
  selected: true,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => state.navigate,
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock('../../hooks/useAsync.js', () => ({
  default: () => ({
    data: { networks: [{ code: 'MTN', label: 'MTN', packageCount: 1 }], packages: [state.package] },
    loading: false,
    error: '',
    reload: vi.fn(),
  }),
}));
vi.mock('../../context/BackendConnectionContext.jsx', () => ({
  useBackendConnection: () => ({ isConnected: true, isWaiting: false, isOffline: false, isUnavailable: false }),
}));
vi.mock('../../context/OrderDraftContext.jsx', () => ({
  useOrderDraft: () => ({
    draft: { network: 'MTN', package: state.selected ? state.package : null, recipientPhone: '' },
    updateDraft: state.updateDraft,
  }),
}));
vi.mock('../../components/NetworkSelector/NetworkSelector.jsx', () => ({ default: () => <div>Network picker</div> }));
vi.mock('../../components/DataCard/DataCard.jsx', () => ({
  default: ({ pkg, onSelect }) => <button type="button" onClick={() => onSelect(pkg)}>{pkg.name}</button>,
}));
vi.mock('../../components/PhoneInput/PhoneInput.jsx', () => ({
  default: ({ value, onChange }) => <input aria-label="Recipient phone number" value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock('../../components/Loader/Loader.jsx', () => ({ default: () => null }));
vi.mock('../../components/Alert/Alert.jsx', () => ({ default: ({ children }) => <div role="alert">{children}</div> }));
vi.mock('../../components/EmptyState/EmptyState.jsx', () => ({ default: ({ title }) => <p>{title}</p> }));

beforeEach(() => {
  state.navigate.mockClear();
  state.updateDraft.mockClear();
  state.selected = true;
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  delete Element.prototype.scrollIntoView;
});

it('scrolls to recipient entry after a selected package advances from the first step', async () => {
  render(<BuyData />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  expect(await screen.findByRole('heading', { name: /Recipient/ })).toBeInTheDocument();
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' }));
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.updateDraft).not.toHaveBeenCalled();
});

it('does not advance or scroll when no package is selected', async () => {
  state.selected = false;
  render(<BuyData />);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('Choose a data bundle');
  expect(screen.queryByRole('heading', { name: /Recipient/ })).not.toBeInTheDocument();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});
