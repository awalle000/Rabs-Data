import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AdminPushSettings from './AdminPushSettings.jsx';

const pushApi = vi.hoisted(() => ({
  getStatus: vi.fn(),
  register: vi.fn(),
  remove: vi.fn(),
  sendTest: vi.fn(),
}));

vi.mock('../../services/adminService.js', () => ({
  getAdminPushStatus: pushApi.getStatus,
  registerAdminPushSubscription: pushApi.register,
  removeAdminPushSubscription: pushApi.remove,
  sendAdminPushTest: pushApi.sendTest,
}));

vi.mock('../Icon/Icon.jsx', () => ({ default: () => null }));

const endpoint = 'https://push.example.test/current-device';
const serializedSubscription = {
  endpoint,
  keys: { p256dh: 'abcdefghijklmnopqrstuvwxyz1234567890_-', auth: 'abcdefghijklmno123456_-' },
};

beforeEach(() => {
  const subscription = { endpoint, toJSON: () => serializedSubscription };
  const registration = {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
  };
  const serviceWorker = {
    register: vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
  };

  Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: { permission: 'granted', requestPermission: vi.fn().mockResolvedValue('granted') },
  });
  Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: serviceWorker });

  pushApi.getStatus.mockReset().mockResolvedValue({ ready: true, publicKey: 'public-key' });
  pushApi.register.mockReset().mockResolvedValue({ success: true });
  pushApi.remove.mockReset().mockResolvedValue({ success: true });
  pushApi.sendTest.mockReset().mockResolvedValue({ success: true, sent: 1 });
});

afterEach(() => {
  delete window.PushManager;
  delete window.Notification;
  delete window.navigator.serviceWorker;
  vi.clearAllMocks();
});

it('persists an existing browser subscription and sends a test only to that device', async () => {
  render(<AdminPushSettings />);

  const sendButton = await screen.findByRole('button', { name: 'Send test' });
  expect(pushApi.register).toHaveBeenCalledWith(serializedSubscription);

  fireEvent.click(sendButton);

  await waitFor(() => expect(pushApi.register).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(pushApi.sendTest).toHaveBeenCalledWith(endpoint));
  expect(pushApi.sendTest).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('A test notification was sent to this device only.')).toBeInTheDocument();
});

it('keeps registration available and does not send a test when persistence fails', async () => {
  pushApi.register.mockRejectedValue({ response: { data: { message: 'Registration failed' } } });
  render(<AdminPushSettings />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Registration failed');
  expect(screen.getByRole('button', { name: 'Enable Admin Notifications' })).toBeInTheDocument();
  expect(pushApi.sendTest).not.toHaveBeenCalled();
});