import express from 'express';
import { getCatalog, getNetworks, getPackages } from '../controllers/dataController.js';

const router = express.Router();

router.get('/catalog', getCatalog);
router.get('/networks', getNetworks);
router.get('/packages', getPackages);

export default router;