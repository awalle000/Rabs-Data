import { afterEach, expect, it, vi } from 'vitest';
import api from './api.js';
import { getCatalog } from './dataService.js';

vi.mock('./api.js', () => ({
  default: { get: vi.fn() },
  getApiBaseUrl: vi.fn(() => 'http://localhost:5000/api'),
}));

afterEach(() => {
  api.get.mockReset();
});

it('shares an in-flight saved-catalog request and fetches a fresh snapshot after completion', async () => {
  let resolveRequest;
  api.get.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));

  const first = getCatalog();
  const concurrent = getCatalog();
  expect(first).toBe(concurrent);
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.get).toHaveBeenCalledWith('/data/catalog');

  const snapshot = {
    success: true,
    count: 1,
    networks: [{ code: 'MTN', packageCount: 1 }],
    packages: [{ _id: 'verified-package', network: 'MTN' }],
  };
  resolveRequest({ data: snapshot });
  await expect(first).resolves.toEqual(snapshot);

  api.get.mockResolvedValueOnce({ data: { ...snapshot, count: 0, packages: [] } });
  await expect(getCatalog()).resolves.toMatchObject({ count: 0, packages: [] });
  expect(api.get).toHaveBeenCalledTimes(2);
});

it('falls back to the existing eligible Mongo-backed endpoints only when catalog route is unavailable', async () => {
  api.get
    .mockRejectedValueOnce({ response: { status: 404 } })
    .mockResolvedValueOnce({ data: { networks: [{ code: 'MTN', packageCount: 1 }] } })
    .mockResolvedValueOnce({ data: { count: 1, packages: [{ _id: 'eligible-package' }] } });

  await expect(getCatalog()).resolves.toEqual({
    networks: [{ code: 'MTN', packageCount: 1 }],
    packages: [{ _id: 'eligible-package' }],
    count: 1,
  });
  expect(api.get.mock.calls.map(([path]) => path)).toEqual([
    '/data/catalog', '/data/networks', '/data/packages',
  ]);
});

it('does not fall back on server or network errors', async () => {
  api.get.mockRejectedValueOnce({ response: { status: 503 } });
  await expect(getCatalog()).rejects.toMatchObject({ response: { status: 503 } });
  expect(api.get).toHaveBeenCalledTimes(1);
});
