import env from './config/environment.js';
import mongoose from 'mongoose';
import connectDB from './config/db.js';
import app from './app.js';
import { startPaymentReconciliation } from './jobs/reconcilePayments.js';
import { startSupplierReconciliation } from './jobs/reconcileSupplierOrders.js';
import { startSupplierCatalogScheduler } from './services/supplierCatalogService.js';
import { startLedgerAudit } from './jobs/auditLedger.js';
import { startSmsDispatcher } from './services/smsNotificationService.js';
import { startAdminPushDispatcher } from './services/adminPushService.js';
import { verifySmtpTransport } from './services/emailService.js';
import { createGracefulShutdown } from './utils/gracefulShutdown.js';

const start = async () => {
  try {
    await connectDB();
  } catch (error) {
    console.error('MongoDB connection failed');
    console.error('Backend was not started because the database is unavailable');
    process.exit(1);
  }

  const server = app.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
    console.log(`Rabs Data API running in ${env.nodeEnv} mode on port ${env.port}`);
    void verifySmtpTransport();
  });

  const backgroundJobs = [
    startPaymentReconciliation(),
    startLedgerAudit(),
    startSmsDispatcher(),
    startAdminPushDispatcher(),
  ];
  const supplierReconciliation = startSupplierReconciliation();
  const supplierCatalogScheduler = startSupplierCatalogScheduler();
  console.log(`[payment-order-recovery] ${env.paymentOrderRecoveryEnabled ? 'enabled' : 'paused'}`);

  const shutdown = createGracefulShutdown({
    server,
    scheduler: supplierReconciliation,
    schedulers: [supplierCatalogScheduler],
    timers: backgroundJobs,
    disconnect: () => mongoose.disconnect(),
  });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exitCode = 1;
    void shutdown('unhandledRejection');
  });
};

start();