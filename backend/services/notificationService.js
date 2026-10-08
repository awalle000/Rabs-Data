import env from '../config/environment.js';

// No SMS or email provider is connected yet. This only logs, and never throws,
// so a notification problem can never break an order.
export const notifyOrderUpdate = async (order) => {
  try {
    if (!env.isProduction) {
      console.log(`[notify] Order ${order.orderId} is now "${order.status}"`);
    }
  } catch (error) {
    console.error('Notification failed:', error.message);
  }
};