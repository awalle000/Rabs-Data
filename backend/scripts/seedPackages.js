import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import DataPackage from '../models/DataPackage.js';
import { NETWORK_CODES } from '../config/networks.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed sample packages in production.');
  process.exit(1);
}

// [dataAmount, validity, providerCost, sellingPrice]. SAMPLE VALUES ONLY.
const SAMPLE = [
  ['1GB', '30 days', 4.5, 5.5],
  ['2GB', '30 days', 8.5, 10],
  ['5GB', '30 days', 20, 23],
  ['10GB', '30 days', 38, 43],
];

await connectDB();

const operations = NETWORK_CODES.flatMap((network) =>
  SAMPLE.map(([dataAmount, validity, providerCost, sellingPrice]) => ({
    updateOne: {
      filter: { network, name: `${dataAmount} Bundle` },
      update: {
        $setOnInsert: { network, name: `${dataAmount} Bundle`, dataAmount, validity, providerCost, sellingPrice, isActive: true },
      },
      upsert: true,
    },
  }))
);

const result = await DataPackage.bulkWrite(operations);
console.log(`Sample packages added: ${result.upsertedCount} (existing ones left untouched).`);

await mongoose.disconnect();