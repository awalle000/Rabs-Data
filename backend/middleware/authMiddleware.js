import jwt from 'jsonwebtoken';
import env from '../config/environment.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';

export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) throw new AppError('Not authorized. Please log in.', 401);

  const decoded = jwt.verify(token, env.jwtSecret);
  const user = await User.findById(decoded.id);

  if (!user || !user.isActive) {
    throw new AppError('Account not found or deactivated', 401);
  }

  if (user.passwordChangedAt) {
    const changedTimestamp = parseInt(user.passwordChangedAt.getTime() / 1000, 10);
    if (decoded.iat < changedTimestamp) {
      throw new AppError('Password recently changed. Please log in again.', 401, 'TOKEN_EXPIRED');
    }
  }

  req.user = user;
  next();
});

// Attaches req.user when a valid token is sent, otherwise continues as a guest.
// An expired or invalid token never blocks a purchase.
export const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next();

  let decoded;
  try {
    decoded = jwt.verify(token, env.jwtSecret);
  } catch {
    return next();
  }

  try {
    const user = await User.findById(decoded.id);
    if (user && user.isActive) {
      if (user.passwordChangedAt) {
        const changedTimestamp = parseInt(user.passwordChangedAt.getTime() / 1000, 10);
        if (decoded.iat < changedTimestamp) return next();
      }
      req.user = user;
    }
    return next();
  } catch (error) {
    return next(error);
  }
};