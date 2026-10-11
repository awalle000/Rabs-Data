import { describe, expect, it } from 'vitest';
import { claimNotificationOnce, parseSseFrames } from './adminNotificationEvents.js';
import { playAdminNotificationSound } from './adminNotificationAudio.js';

describe('admin notification delivery helpers', () => {
  it('does not replay a notification or sound after reconnecting with the same event', () => {
    const seen = new Set(['event-1']);
    expect(claimNotificationOnce(seen, 'event-1')).toBe(false);
    expect(claimNotificationOnce(seen, 'event-2')).toBe(true);
    expect(claimNotificationOnce(seen, 'event-2')).toBe(false);
  });

  it('parses complete SSE frames and retains a partial frame for the next chunk', () => {
    const first = parseSseFrames('event: notification\ndata: {"id":"event-1"}\n\nevent: notification\ndata: {"id":');
    expect(first.notifications).toEqual([{ id: 'event-1' }]);
    const second = parseSseFrames(`${first.remainder}"event-2"}\n\n`);
    expect(second.notifications).toEqual([{ id: 'event-2' }]);
    expect(second.remainder).toBe('');
  });

  it('treats blocked browser audio as a recoverable result, not a dashboard error', async () => {
    expect(await playAdminNotificationSound(0.5)).toBe(false);
  });
});