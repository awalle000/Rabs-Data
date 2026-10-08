import dns from 'node:dns';
import mongoose from 'mongoose';
import env from './environment.js';

const classifyMongoFailure = (error) => {
  const message = String(error?.message || '').toLowerCase();
  if (!message) return 'unknown';
  if (/authentication failed|auth failed|unauthorized|invalid credentials|not authorized/.test(message)) return 'credentials';
  if (/ip|whitelist|network access|connection refused|timed out|server selection|econnrefused|timeout/.test(message)) return 'network/ip access';
  if (/enotfound|dns|resolve|srv/.test(message)) return 'dns';
  if (/uri|mongodb.*parse|invalid connection string/.test(message)) return 'uri/config';
  return 'unknown';
};

// Optional: set DNS_SERVERS=8.8.8.8,1.1.1.1 in .env if your network's DNS
// cannot resolve MongoDB Atlas (mongodb+srv) addresses.
if (process.env.DNS_SERVERS) {
  dns.setServers(
    process.env.DNS_SERVERS.split(',')
      .map((server) => server.trim())
      .filter(Boolean)
  );
}

const connectDB = async () => {
  const mongoConfigured = Boolean(env.mongoUri);
  const hasUsername = /mongodb(?:\+srv)?:\/\/[A-Za-z0-9._~-]+:/i.test(env.mongoUri || '');
  const hasPassword = /mongodb(?:\+srv)?:\/\/[^/:]+:[^/@]+@/i.test(env.mongoUri || '');

  console.log('MongoDB configuration detected');
  console.log(`MongoDB URI: ${mongoConfigured ? 'configured' : 'missing'}`);
  console.log(`Database: ${mongoConfigured ? 'configured' : 'missing'}`);
  console.log(`Username: ${hasUsername ? 'configured' : 'missing'}`);
  console.log(`Password: ${hasPassword ? 'configured' : 'missing'}`);

  try {
    const conn = await mongoose.connect(env.mongoUri, {
      serverSelectionTimeoutMS: 15000,
      retryWrites: true,
      autoIndex: true,
    });
    console.log(`MongoDB connected successfully: ${conn.connection.host}`);
    return conn;
  } catch (error) {
    const category = classifyMongoFailure(error);
    console.error('MongoDB connection failed');
    console.error(`Reason category: ${category}`);
    console.error(`MongoDB error: ${error.message}`);
    throw error;
  }
};

export default connectDB;