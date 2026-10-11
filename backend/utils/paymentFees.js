import env from '../config/environment.js';
import { roundMoney } from './money.js';

/**
 * Calculates customer payable amount and gateway fee structure.
 * Respects business configuration on whether payment processing fee is passed to customer.
 *
 * @param {number} basePrice Selling price of bundle
 * @returns {object} Pricing breakdown
 */
export const calculateOrderPricing = (basePrice) => {
  const base = roundMoney(Number(basePrice) || 0);
  return {
    baseProductPrice: base,
    fee: 0,
    paymentGatewayFee: 0,
    customerChargedAmount: base,
    feePassedToCustomer: false,
    feePercentage: 0,
  };
};

/**
 * Calculates gross profit and net profit according to financial rules:
 * - customerSellingPrice = amount charged for the data product (baseProductPrice)
 * - supplierCost = actual PadodaTagh cost recorded at purchase time
 * - grossProfit = customerSellingPrice - supplierCost
 * - If fee is passed to customer: netProfit = grossProfit
 * - If fee is paid by business: netProfit = grossProfit - paymentGatewayFee
 */
export const calculateProfits = ({
  baseProductPrice,
  sellingPrice,
  supplierCost,
  providerCost,
  paymentGatewayFee = 0,
  feePassedToCustomer = env.payment.passFeesToCustomer,
}) => {
  const base = roundMoney(Number(baseProductPrice ?? sellingPrice ?? 0));
  const cost = roundMoney(Number(supplierCost ?? providerCost ?? 0));
  const fee = roundMoney(Number(paymentGatewayFee ?? 0));

  const grossProfit = roundMoney(base - cost);
  const netProfit = feePassedToCustomer ? grossProfit : roundMoney(grossProfit - fee);

  return { grossProfit, netProfit };
};
