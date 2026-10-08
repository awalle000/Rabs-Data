import express from 'express';
import { getNetworks, getPackages } from '../controllers/dataController.js';

const router = express.Router();

router.get('/networks', getNetworks);
router.get('/packages', getPackages);

export default router;