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
  deletePackage,
  getTransactions,
  getSupplierBalance,
  getSupplierSyncStatus,
  syncSupplierBundles,
  checkOrderSupplierStatus,
  getSupplierOrders,
  registerAdmin,
} from '../controllers/adminController.js';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';
import {
  mongoIdParam,
  orderIdParam,
  packageCreateRules,
  packageUpdateRules,
  creditWalletRules,
  validate,
  registerRules,
} from '../utils/validators.js';

const router = express.Router();

router.use(protect, adminOnly);

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
router.delete('/packages/:id', mongoIdParam('id'), validate, deletePackage);

router.get('/transactions', getTransactions);

router.get('/supplier/balance', getSupplierBalance);
router.get('/supplier/sync-status', getSupplierSyncStatus);
router.post('/supplier/sync-bundles', syncSupplierBundles);
router.get('/supplier/orders', getSupplierOrders);

export default router;