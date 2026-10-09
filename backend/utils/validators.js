import { body, param, validationResult } from 'express-validator';
import AppError from './AppError.js';
import { NETWORK_CODES } from '../config/networks.js';

const GHANA_PHONE = /^0(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const ORDER_CODE = /^DH-\d{8}-\d{6}$/;

// Accepts 024 123 4567, +233241234567, 233241234567. Returns 0241234567 or null.
export const normalizePhone = (input) => {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+233')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('233')) digits = `0${digits.slice(3)}`;
  return GHANA_PHONE.test(digits) ? digits : null;
};

export const isObjectId = (value) => OBJECT_ID.test(String(value));

export const validate = (req, res, next) => {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const errors = result.array().map((item) => ({ field: item.path, message: item.msg }));
  const error = new AppError(errors[0].message, 400, 'VALIDATION_ERROR');
  error.details = errors;
  return next(error);
};

const phoneField = (field, { optional = false } = {}) => {
  const chain = body(field);
  if (optional) chain.optional({ values: 'falsy' });
  return chain
    .trim()
    .custom((value) => {
      if (!normalizePhone(value)) throw new Error('Enter a valid Ghana phone number');
      return true;
    })
    .customSanitizer((value) => normalizePhone(value));
};

const passwordField = (field) =>
  body(field)
    .isLength({ min: 8, max: 72 })
    .withMessage('Password must be 8 to 72 characters')
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain a letter')
    .matches(/\d/)
    .withMessage('Password must contain a number');

/* ----------------------------- Params ----------------------------- */

export const mongoIdParam = (name = 'id') =>
  param(name)
    .custom((value) => isObjectId(value))
    .withMessage('Invalid ID');

export const orderIdParam = param('id')
  .custom((value) => OBJECT_ID.test(value) || ORDER_CODE.test(value))
  .withMessage('Invalid order ID');

/* ------------------------------ Auth ------------------------------ */

export const registerRules = [
  body('name').trim().isLength({ min: 2, max: 80 }).withMessage('Name must be 2 to 80 characters'),
  body('email')
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  phoneField('phone'),
  passwordField('password'),
];

export const loginRules = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body('password').notEmpty().withMessage('Password is required'),
];

export const forgotPasswordRules = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
];

export const resetPasswordRules = [
  passwordField('password'),
  body('confirmPassword')
    .custom((value, { req }) => {
      if (value !== req.body.password) {
        throw new Error('Passwords do not match');
      }
      return true;
    }),
];

/* ------------------------------ Profile ------------------------------ */

export const profileRules = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('Name must be 2 to 80 characters'),
  phoneField('phone', { optional: true }),
];

export const changePasswordRules = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  passwordField('newPassword'),
];

/* ------------------------------ Orders ------------------------------ */

export const createOrderRules = [
  body('packageId').isMongoId().withMessage('Select a valid data package'),
  phoneField('recipientPhone'),
  phoneField('contactPhone', { optional: true }),
  body('contactEmail')
    .optional({ values: 'falsy' })
    .trim()
    .isEmail()
    .withMessage('Enter a valid email address')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body('paymentMethod')
    .optional()
    .isIn(['direct', 'wallet'])
    .withMessage('Payment method must be direct or wallet'),
  body('idempotencyKey')
    .optional({ values: 'falsy' })
    .trim()
    .isLength({ min: 16, max: 128 })
    .withMessage('The idempotency key must be 16 to 128 characters long')
    .matches(/^[A-Za-z0-9_-]+$/)
    .withMessage('The idempotency key contains invalid characters'),
];

export const lookupOrderRules = [
  body('id').optional({ values: 'falsy' }).isMongoId().withMessage('Invalid order'),
  body('token').optional({ values: 'falsy' }).isString().isLength({ min: 20, max: 100 }),
  body('orderId')
    .optional({ values: 'falsy' })
    .trim()
    .matches(/^DH-\d{8}-\d{6}$/i)
    .withMessage('Order ID looks like DH-20260930-000001'),
  body('phone')
    .optional({ values: 'falsy' })
    .trim()
    .custom((value) => {
      if (!normalizePhone(value)) throw new Error('Enter a valid Ghana phone number');
      return true;
    })
    .customSanitizer((value) => normalizePhone(value)),
];

/* ------------------------------ Payments ------------------------------ */

export const initializePaymentRules = [
  body('orderId').isMongoId().withMessage('Invalid order'),
  body('trackingToken').optional({ values: 'falsy' }).isString().isLength({ max: 100 }),
];

/* ------------------------------ Wallet ------------------------------ */

export const fundWalletRules = [
  body('amount')
    .isFloat({ min: 1, max: 5000 })
    .withMessage('Amount must be between GHS 1 and GHS 5,000')
    .toFloat(),
];

export const creditWalletRules = [
  body('amount')
    .isFloat({ min: 1, max: 5000 })
    .withMessage('Amount must be between GHS 1 and GHS 5,000')
    .toFloat(),
  body('note').optional().trim().isLength({ max: 200 }).withMessage('Note is too long'),
];

/* ------------------------------ Packages (admin) ------------------------------ */

const packageFields = (optional) => {
  const field = (chain) => (optional ? chain.optional() : chain);
  return [
    field(body('network'))
      .isIn(NETWORK_CODES)
      .withMessage(`Network must be one of: ${NETWORK_CODES.join(', ')}`),
    field(body('name'))
      .trim()
      .isLength({ min: 1, max: 80 })
      .withMessage('Package name is required (max 80 characters)'),
    field(body('dataAmount')).trim().notEmpty().withMessage('Data amount is required (e.g. 1GB)'),
    field(body('validity')).trim().notEmpty().withMessage('Validity is required (e.g. 30 days)'),
    field(body('providerCost'))
      .isFloat({ min: 0 })
      .withMessage('Provider cost must be 0 or more')
      .toFloat(),
    field(body('sellingPrice'))
      .isFloat({ min: 0 })
      .withMessage('Selling price must be 0 or more')
      .toFloat(),
    body('providerPackageCode').optional().trim().isLength({ max: 100 }),
    body('isActive').optional().isBoolean().withMessage('isActive must be true or false').toBoolean(),
  ];
};

export const packageCreateRules = packageFields(false);
export const packageUpdateRules = packageFields(true);