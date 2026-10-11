export const orderCreatedNotification = (order) => ({
  eventId: `order-created:${order._id}`,
  category: 'orders',
  type: 'order_created',
  title: 'New order placed',
  message: `${order.orderId}: ${order.dataAmount} ${order.network}, GHS ${Number(order.sellingPrice).toFixed(2)}.`,
  priority: 'important',
  sound: true,
  link: `/admin/orders?search=${encodeURIComponent(order.orderId)}&open=${order._id}`,
  relatedOrder: order._id,
});

export const paymentMismatchNotification = (payment) => ({
  eventId: `payment-mismatch:${payment._id}`,
  category: 'payments',
  type: 'payment_mismatch',
  title: 'Payment verification mismatch',
  message: `Payment ${payment.reference} failed amount or currency verification.`,
  priority: 'critical',
  sound: true,
  link: payment.order
    ? `/admin/orders?search=${encodeURIComponent(payment.reference)}&open=${payment.order}`
    : '/admin/transactions',
  relatedPayment: payment._id,
  relatedOrder: payment.order || null,
});

export const supplierFailureNotification = (order) => ({
  eventId: `supplier-failure:${order._id}`,
  category: 'supplier',
  type: 'supplier_purchase_failed',
  title: 'Supplier purchase failed',
  message: `Order ${order.orderId} could not be submitted to ${order.supplier || 'the supplier'}.`,
  priority: 'critical',
  sound: true,
  link: `/admin/orders?search=${encodeURIComponent(order.orderId)}&open=${order._id}`,
  relatedOrder: order._id,
});

export const supplierUncertainNotification = (order) => ({
  eventId: `supplier-uncertain:${order._id}`,
  category: 'supplier',
  type: 'supplier_purchase_uncertain',
  title: 'Supplier delivery needs review',
  message: `Delivery status for order ${order.orderId} with ${order.supplier || 'the supplier'} is uncertain; do not resubmit it.`,
  priority: 'critical',
  sound: true,
  link: `/admin/orders?search=${encodeURIComponent(order.orderId)}&open=${order._id}`,
  relatedOrder: order._id,
});

export const supplierPendingNotification = (order) => ({
  eventId: `supplier-pending:${order._id}`,
  category: 'supplier',
  type: 'supplier_purchase_pending_review',
  title: 'Supplier purchase is taking longer than expected',
  message: `Order ${order.orderId} is still pending at ${order.supplier || 'the supplier'} and needs a status review.`,
  priority: 'important',
  sound: true,
  link: `/admin/orders?search=${encodeURIComponent(order.orderId)}&open=${order._id}`,
  relatedOrder: order._id,
});

export const paymentReviewNotification = (payment, reason) => ({
  eventId: `payment-review:${payment._id}:${reason}`,
  category: 'payments',
  type: 'payment_verification_review',
  title: 'Payment verification needs review',
  message: `Payment ${payment.reference} could not be safely verified (${String(reason).replace(/_/g, ' ')}).`,
  priority: 'critical',
  sound: true,
  link: payment.order ? `/admin/orders?search=${encodeURIComponent(payment.reference)}&open=${payment.order}` : '/admin/transactions',
  relatedPayment: payment._id,
  relatedOrder: payment.order || null,
});

export const ledgerDiscrepancyNotification = ({ eventId, title, message }) => ({
  eventId,
  category: 'payments',
  type: 'ledger_discrepancy',
  title,
  message,
  priority: 'critical',
  sound: true,
  link: '/admin/transactions',
});