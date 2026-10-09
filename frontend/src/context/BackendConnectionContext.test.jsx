import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BackendConnectionProvider, useBackendConnection } from './BackendConnectionContext.jsx';
import Login from '../pages/Login/Login.jsx';

const authState = vi.hoisted(() => ({ login: vi.fn() }));

vi.mock('./AuthContext.jsx', () => ({
  useAuth: () => ({
    login: authState.login,
  }),
}));

function ConnectionProbe() {
  const connection = useBackendConnection();

  return (
    <div>
      <span data-testid="status">{connection.status}</span>
      <span data-testid="message">{connection.message}</span>
      <button type="button" onClick={() => connection.retryConnection()}>
        Retry
      </button>
      <button type="button" onClick={() => connection.waitForBackend()}>
        Check
      </button>
    </div>
  );
}

describe('BackendConnectionContext', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    globalThis.__RABS_BACKEND_RETRY_DELAYS__ = [0, 0, 0, 0, 0];
    globalThis.__RABS_BACKEND_MAX_WAIT_MS__ = 2000;
  });

  afterEach(() => {
    delete globalThis.__RABS_BACKEND_RETRY_DELAYS__;
    delete globalThis.__RABS_BACKEND_MAX_WAIT_MS__;
    vi.restoreAllMocks();
  });

  it('waits for a waking backend and marks success once it responds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'));
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.getByTestId('message').textContent).toContain('Connected');
  });

  it('shows offline status when the browser is offline', async () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });

    render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('offline'));
  });

  it('does not submit the same login twice while backend readiness is being checked', async () => {
    authState.login.mockResolvedValue({ user: { name: 'A', role: 'customer' }, token: 'token' });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <MemoryRouter>
          <Login />
        </MemoryRouter>
      </BackendConnectionProvider>
    );

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    const button = screen.getByRole('button', { name: 'Log in' });

    await userEvent.type(email, 'user@example.com');
    await userEvent.type(password, 'Password1');
    await userEvent.click(button);

    await waitFor(() => expect(authState.login).toHaveBeenCalledTimes(1));
    expect(authState.login).toHaveBeenCalledWith({ email: 'user@example.com', password: 'Password1' });
  });
});
