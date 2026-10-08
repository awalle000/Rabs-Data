import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/environment.js';
import { apiLimiter } from './middleware/rateLimitMiddleware.js';
import { notFound, errorHandler } from './middleware/errorMiddleware.js';
import { handleDataProviderWebhook } from './webhooks/dataProviderWebhook.js';
import authRoutes from './routes/authRoutes.js';
import userRoutes from './routes/userRoutes.js';
import dataRoutes from './routes/dataRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import walletRoutes from './routes/walletRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import analyticsRoutes from './routes/analyticsRoutes.js';

const app = express();

app.set('trust proxy', 1); // Render sits behind a proxy

app.use(helmet());
app.use(cors({ origin: env.clientUrls, credentials: true }));
if (!env.isProduction) app.use(morgan('dev'));

// Webhooks need the untouched raw body to verify signatures.
// These must come BEFORE express.json().
app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '100kb' }));
app.use('/api/webhooks/data-provider', express.raw({ type: '*/*', limit: '100kb' }));

app.use(express.json({ limit: '10kb' }));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: 'rabs-data-api',
    environment: env.nodeEnv,
    time: new Date().toISOString(),
  });
});

app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/analytics', analyticsRoutes);
app.post('/api/webhooks/data-provider', handleDataProviderWebhook);

app.use(notFound);
app.use(errorHandler);

export default app;