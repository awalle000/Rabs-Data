import AdminNotification from '../models/AdminNotification.js';

export const persistDeduplicatedNotification = async (Model, notification) => {
  try {
    return await Model.create(notification);
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }
};

export const createAdminNotification = (notification) => persistDeduplicatedNotification(AdminNotification, notification);

export const notifyAdminsSafely = async (notification) => {
  try {
    return await createAdminNotification(notification);
  } catch (error) {
    console.error('[admin-notification] persistence failed:', error.message);
    return null;
  }
};

export const toAdminNotification = (notification, userId) => {
  const item = notification.toObject ? notification.toObject() : notification;
  const user = String(userId);
  return {
    id: String(item._id),
    category: item.category,
    type: item.type,
    title: item.title,
    message: item.message,
    priority: item.priority,
    sound: item.sound,
    link: item.link,
    relatedOrder: item.relatedOrder ? String(item.relatedOrder) : null,
    relatedPayment: item.relatedPayment ? String(item.relatedPayment) : null,
    relatedPackage: item.relatedPackage ? String(item.relatedPackage) : null,
    createdAt: item.createdAt,
    isRead: (item.readBy || []).some((id) => String(id) === user),
    isArchived: (item.archivedBy || []).some((id) => String(id) === user),
  };
};