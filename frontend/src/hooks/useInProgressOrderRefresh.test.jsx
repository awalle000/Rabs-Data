import { act, cleanup, renderHook } from '@testing-library/react';
import useInProgressOrderRefresh from './useInProgressOrderRefresh.js';

let visibilityState;

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('refreshes an in-progress order periodically while the page is visible', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useInProgressOrderRefresh(true, refresh));

  await act(async () => {
    vi.advanceTimersByTime(15000);
  });

  expect(refresh).toHaveBeenCalledTimes(1);
});

test('pauses while hidden and refreshes once when the page becomes visible', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  renderHook(() => useInProgressOrderRefresh(true, refresh));
  visibilityState = 'hidden';

  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(refresh).not.toHaveBeenCalled();

  visibilityState = 'visible';
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('stops polling when order becomes terminal and clears interval on unmount', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
  const hook = renderHook(
    ({ inProgress }) => useInProgressOrderRefresh(inProgress, refresh),
    { initialProps: { inProgress: true } }
  );

  hook.rerender({ inProgress: false });
  expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(refresh).not.toHaveBeenCalled();

  hook.rerender({ inProgress: true });
  hook.unmount();
  expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
});