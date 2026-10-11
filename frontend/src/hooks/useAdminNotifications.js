import { useContext } from 'react';
import { AdminNotificationContext } from '../context/AdminNotificationContextValue.js';

export function useAdminNotifications() {
  const context = useContext(AdminNotificationContext);
  if (!context) throw new Error('useAdminNotifications must be used inside AdminNotificationProvider');
  return context;
}