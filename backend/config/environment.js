import dotenv from 'dotenv';

dotenv.config();

const required = ['MONGODB_URI', 'JWT_SECRET'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const list = (value) =>
  (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const trimSlash = (value) => value.replace(/\/+$/, '');

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT) || 5000;

if (isProduction && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters in production');
  process.exit(1);
}

if (isProduction && !(process.env.API_PUBLIC_URL || '').startsWith('https://')) {
  console.error('API_PUBLIC_URL must be your public https backend URL in production');
  process.exit(1);
}

const clientUrls = list(process.env.CLIENT_URL || process.env.CLIENT_URLS || process.env.CORS_ORIGIN);
if (!isProduction) {
  ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'].forEach((u) => {
    if (!clientUrls.includes(u)) clientUrls.push(u);
  });
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port,
  apiPublicUrl: trimSlash(process.env.API_PUBLIC_URL || `http://localhost:${port}`),
  clientUrls: clientUrls.length ? clientUrls : ['http://localhost:5173'],
  clientUrl: clientUrls[0] || 'http://localhost:5173',
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  currency: 'GHS',
  walletEnabled: process.env.WALLET_ENABLED !== 'false',
  enabledNetworks: list(process.env.ENABLED_NETWORKS),
  allowPaymentsWithoutDelivery: process.env.ALLOW_PAYMENTS_WITHOUT_DELIVERY === 'true',
  gateway: {
    baseUrl: process.env.EXPLABS_BASE_URL || 'https://api.experientiallabs.ai/v1',
    apiKey: process.env.EXPLABS_API_KEY,
  },
  payment: {
    provider: 'hubtel',
    apiId: process.env.HUBTEL_CLIENT_ID || process.env.HUBTEL_API_ID,
    apiKey: process.env.HUBTEL_CLIENT_SECRET || process.env.HUBTEL_API_KEY,
    merchantAccountNumber: process.env.HUBTEL_MERCHANT_ACCOUNT || process.env.HUBTEL_MERCHANT_ACCOUNT_NUMBER,
    checkoutBaseUrl: trimSlash(process.env.HUBTEL_BASE_URL || process.env.HUBTEL_CHECKOUT_BASE_URL || 'https://payproxyapi.hubtel.com'),
    statusBaseUrl: trimSlash(process.env.HUBTEL_STATUS_BASE_URL || 'https://api-txnstatus.hubtel.com'),
    webhookToken: process.env.HUBTEL_WEBHOOK_TOKEN,
    passFeesToCustomer: process.env.HUBTEL_PASS_FEES_TO_CUSTOMER === 'true',
    feePercentage: Number(process.env.HUBTEL_FEE_PERCENTAGE) || 1.95,
    feeFixed: Number(process.env.HUBTEL_FEE_FIXED) || 0,
  },
  dataProvider: {
    baseUrl: process.env.REMADATA_BASE_URL || process.env.DATA_PROVIDER_BASE_URL || 'https://remadata.com/api',
    apiKey: process.env.REMADATA_API_KEY || process.env.DATA_PROVIDER_API_KEY || '',
    secret: process.env.DATA_PROVIDER_SECRET || '',
  },
  remadata: {
    baseUrl: trimSlash(process.env.REMADATA_BASE_URL || process.env.DATA_PROVIDER_BASE_URL || 'https://remadata.com/api'),
    apiKey: process.env.REMADATA_API_KEY || process.env.DATA_PROVIDER_API_KEY || '',
  },
  email: {
    from: process.env.EMAIL_FROM || 'Rabs Data <noreply@rabsdata.com>',
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  },
});

export default env;