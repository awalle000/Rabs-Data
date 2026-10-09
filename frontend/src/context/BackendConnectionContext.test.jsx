import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByTestId('message').textContent).toContain('API is responding');
  });

  it('sends only one initial health request under React StrictMode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <React.StrictMode>
        <BackendConnectionProvider>
          <ConnectionProbe />
        </BackendConnectionProvider>
      </React.StrictMode>
    );

    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows the waking message while the health request is delayed', async () => {
    globalThis.__RABS_BACKEND_RETRY_DELAYS__ = [30];
    let resolveHealth;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveHealth = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('status').textContent).toBe('backend_waking');
    expect(screen.getByTestId('message').textContent).toContain('server is waking up');
    resolveHealth({ ok: true, status: 200 });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'));
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

  it('aborts health work offline and resumes with one check when online', async () => {
    let rejectFirstRequest;
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, { signal }) => new Promise((resolve, reject) => {
        rejectFirstRequest = reject;
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestSignal = fetchMock.mock.calls[0][1].signal;
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('offline'));
    expect(requestSignal.aborted).toBe(true);
    rejectFirstRequest?.(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('shares an in-flight health check instead of starting duplicate requests', async () => {
    let resolveHealth;
    const fetchMock = vi.fn(() => new Promise((resolve) => { resolveHealth = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveHealth({ ok: true, status: 200 });
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('connected'));
  });

  it('aborts an in-flight health request when the provider unmounts', async () => {
    let resolveHealth;
    const fetchMock = vi.fn((_url, options) => new Promise((resolve) => {
      resolveHealth = resolve;
      options.signal.addEventListener('abort', () => resolve({ ok: true, status: 200 }));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const requestSignal = fetchMock.mock.calls[0][1].signal;
    unmount();
    expect(requestSignal.aborted).toBe(true);
    resolveHealth({ ok: true, status: 200 });
  });

  it('stops retrying when the configured maximum wait expires', async () => {
    vi.useFakeTimers();
    globalThis.__RABS_BACKEND_RETRY_DELAYS__ = [10];
    globalThis.__RABS_BACKEND_MAX_WAIT_MS__ = 35;
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <BackendConnectionProvider>
        <ConnectionProbe />
      </BackendConnectionProvider>
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    vi.useRealTimers();

    expect(screen.getByTestId('status').textContent).toBe('backend_unavailable');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
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
