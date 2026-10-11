import express from 'express';
import {
  getDashboard,
  getOrders,
  getOrderDetails,
  getCustomers,
  creditCustomerWallet,
  getPackages,
  createPackage,
  updatePackage,
  updatePackageActivation,
  deletePackage,
  getTransactions,
  getSupplierBalance,
  getSupplierSyncStatus,
  syncSupplierBundles,
  checkOrderSupplierStatus,
  getSupplierManagement,
  updateSupplierManagement,
  refreshSupplierHealth,
  registerAdmin,
} from '../controllers/adminController.js';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';
import {
  listAdminNotifications,
  markAllAdminNotificationsRead,
  streamAdminNotifications,
  updateAdminNotification,
} from '../controllers/adminNotificationController.js';
import {
  mongoIdParam,
  orderIdParam,
  packageCreateRules,
  packageUpdateRules,
  packageActivationRules,
  creditWalletRules,
  validate,
  registerRules,
} from '../utils/validators.js';

const router = express.Router();

router.use(protect, adminOnly);

router.get('/notifications/stream', streamAdminNotifications);
router.get('/notifications', listAdminNotifications);
router.patch('/notifications/read-all', markAllAdminNotificationsRead);
router.patch('/notifications/:id', updateAdminNotification);

router.get('/dashboard', getDashboard);
router.post('/register-admin', registerRules, validate, registerAdmin);

router.get('/orders', getOrders);
router.get('/orders/:id', orderIdParam, validate, getOrderDetails);
router.post('/orders/:id/check-supplier-status', orderIdParam, validate, checkOrderSupplierStatus);

router.get('/customers', getCustomers);
router.post('/customers/:id/wallet-credit', mongoIdParam('id'), creditWalletRules, validate, creditCustomerWallet);

router.get('/packages', getPackages);
router.post('/packages', packageCreateRules, validate, createPackage);
router.put('/packages/:id', mongoIdParam('id'), packageUpdateRules, validate, updatePackage);
router.patch('/packages/:id/activation', mongoIdParam('id'), packageActivationRules, validate, updatePackageActivation);
router.delete('/packages/:id', mongoIdParam('id'), validate, deletePackage);

router.get('/transactions', getTransactions);

router.get('/supplier/balance', getSupplierBalance);
router.get('/supplier/sync-status', getSupplierSyncStatus);
router.post('/supplier/sync-bundles', syncSupplierBundles);
router.get('/supplier/management', getSupplierManagement);
router.put('/supplier/management', updateSupplierManagement);
router.post('/supplier/health-check', refreshSupplierHealth);

export default router;