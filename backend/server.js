import env from './config/environment.js';
import connectDB from './config/db.js';
import app from './app.js';
import { startPaymentReconciliation } from './jobs/reconcilePayments.js';
import { startSupplierReconciliation } from './jobs/reconcileSupplierOrders.js';

const start = async () => {
  try {
    await connectDB();
  } catch (error) {
    console.error('MongoDB connection failed');
    console.error('Backend was not started because the database is unavailable');
    process.exit(1);
  }

  app.listen(env.port, () => {
    console.log(`Backend running on http://localhost:${env.port}`);
    console.log(`Rabs Data API running in ${env.nodeEnv} mode on port ${env.port}`);
  });

  startPaymentReconciliation();
  startSupplierReconciliation();
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

start();