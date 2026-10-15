import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import Home from './Home.jsx';

const state = vi.hoisted(() => ({ data: null, loading: false, error: '', reload: vi.fn() }));

vi.mock('../../hooks/useAsync.js', () => ({
  default: () => ({ data: state.data, loading: state.loading, error: state.error, reload: state.reload }),
}));
vi.mock('../../context/BackendConnectionContext.jsx', () => ({
  useBackendConnection: () => ({ isConnected: true, isWaiting: false, isOffline: false, isUnavailable: false }),
}));
vi.mock('../../components/DataCard/DataCard.jsx', () => ({
  default: ({ pkg }) => <article>{pkg.name}</article>,
}));
vi.mock('../../components/Loader/Loader.jsx', () => ({ default: () => null }));
vi.mock('../../components/Alert/Alert.jsx', () => ({
  default: ({ children, onRetry }) => (
    <div role="alert">
      {children}
      {onRetry && <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  ),
}));
vi.mock('../../components/EmptyState/EmptyState.jsx', () => ({
  default: ({ title, message }) => <div><h3>{title}</h3><p>{message}</p></div>,
}));
vi.mock('../../components/NetworkLogo/NetworkLogo.jsx', () => ({
  default: ({ network }) => <span>{network}</span>,
}));
vi.mock('../../components/Icon/Icon.jsx', () => ({ default: () => null }));

beforeEach(() => {
  state.data = null;
  state.loading = false;
  state.error = '';
  state.reload.mockReset();
});

const renderHome = () => render(<MemoryRouter><Home /></MemoryRouter>);

it('renders packages and counts from the public catalog response', () => {
  state.data = {
    success: true,
    catalogStatus: 'available',
    networks: [{ code: 'MTN', label: 'MTN', packageCount: 1 }],
    count: 1,
    packages: [{ _id: 'package-mtn-1gb', network: 'MTN', name: 'MTN 1GB', sellingPrice: 10 }],
  };

  renderHome();

  expect(screen.getByText('MTN 1GB')).toBeInTheDocument();
  expect(screen.getByText('1 available bundles')).toBeInTheDocument();
});

it('shows the API diagnostic when no packages pass catalog checks', () => {
  state.data = {
    success: true,
    catalogStatus: 'no_eligible_packages',
    catalogMessage: 'No active packages currently pass supplier verification and pricing checks.',
    networks: [{ code: 'MTN', label: 'MTN', packageCount: 0 }],
    count: 0,
    packages: [],
  };

  renderHome();

  expect(screen.getByText('No active packages currently pass supplier verification and pricing checks.')).toBeInTheDocument();
  expect(screen.queryByText(/Check back shortly/)).not.toBeInTheDocument();
});

it('keeps the last successful packages visible and offers retry when a refresh fails', () => {
  state.data = {
    success: true,
    catalogStatus: 'available',
    networks: [{ code: 'MTN', label: 'MTN', packageCount: 1 }],
    count: 1,
    packages: [{ _id: 'package-mtn-1gb', network: 'MTN', name: 'MTN 1GB', sellingPrice: 10 }],
  };
  const view = renderHome();
  state.data = null;
  state.loading = false;
  state.error = 'The data catalog refresh failed. Please retry shortly.';
  view.rerender(<MemoryRouter><Home /></MemoryRouter>);

  expect(screen.getByText('MTN 1GB')).toBeInTheDocument();
  expect(screen.getByText('1 bundles')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(/refresh failed/i);
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
});

it('keeps the last successful packages visible while a refresh is loading', () => {
  state.data = {
    success: true,
    catalogStatus: 'available',
    networks: [{ code: 'MTN', label: 'MTN', packageCount: 1 }],
    count: 1,
    packages: [{ _id: 'package-mtn-1gb', network: 'MTN', name: 'MTN 1GB', sellingPrice: 10 }],
  };
  const view = renderHome();
  state.loading = true;
  view.rerender(<MemoryRouter><Home /></MemoryRouter>);

  expect(screen.getByText('MTN 1GB')).toBeInTheDocument();
  expect(screen.getByText('1 bundles')).toBeInTheDocument();
});