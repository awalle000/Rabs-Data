import mongoose from 'mongoose';

const smsDispatchStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'padodatagh-sms' },
  nextAllowedAt: { type: Date, default: new Date(0) },
}, { versionKey: false });

export default mongoose.model('SmsDispatchState', smsDispatchStateSchema);