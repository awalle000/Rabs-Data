import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { BackendConnectionProvider } from './BackendConnectionContext.jsx';

const authState = vi.hoisted(() => ({ getMe: vi.fn() }));

vi.mock('../services/authService.js', () => ({
  getMe: authState.getMe,
}));

function AuthProbe() {
  const { user, loading } = useAuth();
  return <span data-testid="auth-state">{loading ? 'loading' : user?.name || 'guest'}</span>;
}

describe('AuthContext startup', () => {
  let savedStorageDescriptor;

  beforeEach(() => {
    savedStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const values = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
    });
  });

  afterEach(() => {
    if (savedStorageDescriptor) Object.defineProperty(window, 'localStorage', savedStorageDescriptor);
    else delete window.localStorage;
    delete globalThis.__RABS_BACKEND_RETRY_DELAYS__;
    delete globalThis.__RABS_BACKEND_MAX_WAIT_MS__;
    vi.restoreAllMocks();
  });

  it('waits for backend health before restoring a saved session', async () => {
    window.localStorage.setItem('maridata_token', JSON.stringify('saved-token'));
    authState.getMe.mockResolvedValue({ user: { name: 'Rabs Customer' } });
    let resolveHealth;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveHealth = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <AuthProvider>
          <AuthProbe />
        </AuthProvider>
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(authState.getMe).not.toHaveBeenCalled();
    resolveHealth({ ok: true, status: 200 });

    await waitFor(() => expect(authState.getMe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('auth-state').textContent).toBe('Rabs Customer'));
  });
});