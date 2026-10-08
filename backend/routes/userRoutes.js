import express from 'express';
import { getProfile, updateProfile, changePassword } from '../controllers/userController.js';
import { protect } from '../middleware/authMiddleware.js';
import { profileRules, changePasswordRules, validate } from '../utils/validators.js';

const router = express.Router();

router.use(protect);

router.get('/profile', getProfile);
router.put('/profile', profileRules, validate, updateProfile);
router.put('/password', changePasswordRules, validate, changePassword);

export default router;