import express from 'express';
import {
  getProfitSummary,
  getProfitByNetwork,
  getProfitByBundle,
  getProfitOverTime,
  getRecentProfitTransactions,
  exportProfitCsv,
} from '../controllers/profitController.js';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';

const router = express.Router();

// All analytics routes are admin-only
router.use(protect, adminOnly);

router.get('/summary', getProfitSummary);
router.get('/by-network', getProfitByNetwork);
router.get('/by-bundle', getProfitByBundle);
router.get('/over-time', getProfitOverTime);
router.get('/recent-transactions', getRecentProfitTransactions);
router.get('/export-csv', exportProfitCsv);

export default router;
