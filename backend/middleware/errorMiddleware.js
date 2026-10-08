import env from '../config/environment.js';
import AppError from '../utils/AppError.js';

export const notFound = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

const normalizeError = (err) => {
  if (err.isOperational) return err;

  if (err.name === 'ValidationError') {
    const first = Object.values(err.errors || {})[0];
    return new AppError(first?.message || 'Validation failed', 400, 'VALIDATION_ERROR');
  }
  if (err.name === 'CastError') return new AppError(`Invalid ${err.path}`, 400);
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'value';
    return new AppError(`Duplicate ${field}. It already exists.`, 409, 'DUPLICATE');
  }
  if (err.name === 'TokenExpiredError') {
    return new AppError('Session expired. Please log in again.', 401);
  }
  if (err.name === 'JsonWebTokenError') return new AppError('Invalid token. Please log in again.', 401);
  if (err.type === 'entity.parse.failed') return new AppError('Invalid JSON body', 400);
  if (err.type === 'entity.too.large') return new AppError('Request body too large', 413);

  return err;
};

// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const handled = normalizeError(err);
  const statusCode = handled.statusCode || 500;

  if (statusCode >= 500) console.error(err);

  res.status(statusCode).json({
    success: false,
    message:
      statusCode >= 500 && env.isProduction ? 'Something went wrong' : handled.message,
    ...(handled.code ? { code: handled.code } : {}),
    ...(handled.details ? { errors: handled.details } : {}),
    ...(env.isProduction ? {} : { stack: err.stack }),
  });
};