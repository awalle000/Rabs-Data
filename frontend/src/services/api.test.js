import { afterEach, describe, expect, it, vi } from 'vitest';
import api from './api.js';
import { createOrder } from './orderService.js';

describe('API request retries', () => {
  const originalAdapter = api.defaults.adapter;

  afterEach(() => {
    api.defaults.adapter = originalAdapter;
    vi.restoreAllMocks();
  });

  it('does not replay a failed purchase POST automatically', async () => {
    const adapter = vi.fn(async (config) => {
      throw Object.assign(new Error('Network unavailable'), { config });
    });
    api.defaults.adapter = adapter;

    await expect(createOrder({ packageId: 'package-1', idempotencyKey: 'order-key-1' })).rejects.toThrow('Network unavailable');

    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0][0].method).toBe('post');
    expect(adapter.mock.calls[0][0].data).toContain('order-key-1');
  });
});