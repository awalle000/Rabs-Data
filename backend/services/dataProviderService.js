import * as padodatagh from './padodataghService.js';
import AppError from '../utils/AppError.js';

/*
 * Data provider abstraction layer.
 * PadodaTagh is the sole active supplier.
 *
 * Contract:
 * - isDataProviderConfigured() -> boolean
 * - getAvailablePackages(network) -> [{ network, providerPackageCode, name, dataAmount, volumeInMB, cost, description }]
 * - purchaseData({ reference, network, providerPackageCode, dataAmount, recipientPhone, volumeInMB })
 *     -> { status, supplierStatus, providerReference, clientReference, supplierCost, refunded, message }
 * - checkTransactionStatus({ reference, providerReference })
 *     -> { status, supplierStatus, providerReference, refunded, message }
 * - getProviderBalance() -> { balance, currency, lastTransactionAt }
 * - verifyWebhookSignature(rawBody, headers) -> boolean
 * - parseWebhookEvent(rawBody) -> { reference, providerReference } | null
 */

const retiredSupplierError = () => {
  const error = new AppError('Only PadodaTagh is an active supplier.', 409, 'SUPPLIER_RETIRED');
  error.notSent = true;
  return error;
};

export const isDataProviderConfigured = (supplier = 'PadodaTagh') =>
  supplier === 'PadodaTagh' && padodatagh.isConfigured();

export const getAvailablePackages = async (network, supplier = 'PadodaTagh') => {
  if (supplier !== 'PadodaTagh') throw retiredSupplierError();

  return (await padodatagh.getOffers())
    .filter((offer) => !network || offer.network === network)
    .map((offer) => ({
      network: offer.network,
      providerPackageCode: offer.providerPackageCode,
      offerId: offer.offerId,
      name: offer.name,
      dataAmount: offer.dataAmount,
      validity: offer.validity,
      volumeInMB: offer.volumeInMB,
      cost: offer.providerCost,
      description: offer.description,
    }));
};

let mockPurchaser = null;
export const setMockPurchaser = (fn) => {
  mockPurchaser = fn;
};

export const purchaseData = async ({
  supplier,
  reference,
  network,
  providerPackageCode,
  dataAmount,
  recipientPhone,
  volumeInMB,
  supplierCost,
}) => {
  if (supplier !== 'PadodaTagh') throw retiredSupplierError();

  if (mockPurchaser) {
    return mockPurchaser({ supplier, reference, network, providerPackageCode, dataAmount, recipientPhone, volumeInMB, supplierCost });
  }

  const result = await padodatagh.buyData({ reference, network, providerPackageCode, recipientPhone, volumeInMB, supplierCost });
  return {
    ...result,
    confirmedNotAccepted: false,
  };
};

const validateSupplierStatusIdentity = (result, reference, providerReference) => {
  const clientReferenceMatches = String(result?.clientReference || '') === String(reference || '');
  const returnedSupplierReference = String(result?.providerReference || '');
  const supplierReferenceMatches = Boolean(returnedSupplierReference)
    && (!providerReference || returnedSupplierReference === String(providerReference));
  if (clientReferenceMatches && supplierReferenceMatches) return result;

  return {
    status: 'uncertain',
    supplierStatus: 'uncertain',
    providerReference: providerReference || null,
    clientReference: result?.clientReference || null,
    refunded: false,
    message: 'PadodaTagh status response did not match the submitted order references.',
  };
};

export const checkTransactionStatus = async ({ supplier, reference, providerReference }) => {
  if (supplier !== 'PadodaTagh') {
    return { status: 'uncertain', supplierStatus: 'uncertain', providerReference: providerReference || null, refunded: false, message: 'Historical order supplier is retired; no automatic status request was made.' };
  }

  {
    try {
      const bySupplierId = await padodatagh.getOrderStatus({ reference, providerReference });
      if (bySupplierId.status !== 'uncertain') {
        const verified = validateSupplierStatusIdentity(bySupplierId, reference, providerReference);
        if (verified.status !== 'uncertain') return verified;
      }
    } catch (error) {
      console.warn(`[dataProvider] PadodaTagh status lookup failed for ${reference}:`, error.message);
      if (error.responseStatus !== 404) {
        return { status: 'uncertain', supplierStatus: 'uncertain', providerReference: providerReference || null, refunded: false, message: 'Could not determine PadodaTagh order status' };
      }
    }

    if (reference && reference !== providerReference) {
      try {
        const byMerchantReference = await padodatagh.getOrderStatus({ reference, providerReference: null });
        if (byMerchantReference.status !== 'uncertain') {
          const verified = validateSupplierStatusIdentity(byMerchantReference, reference, providerReference);
          if (verified.status !== 'uncertain') return verified;
        }
      } catch (error) {
        if (error.responseStatus !== 404) {
          return { status: 'uncertain', supplierStatus: 'uncertain', providerReference: providerReference || null, refunded: false, message: 'Could not determine PadodaTagh order status' };
        }
      }
    }

    try {
      const historyResult = await padodatagh.getHistoryOrder(reference);
      if (historyResult) return validateSupplierStatusIdentity(historyResult, reference, providerReference);
    } catch (error) {
      console.warn(`[dataProvider] PadodaTagh history lookup failed for ${reference}:`, error.message);
    }
    return { status: 'uncertain', supplierStatus: 'uncertain', providerReference: providerReference || null, refunded: false, message: 'Could not determine PadodaTagh order status' };
  }

};

export const getProviderBalance = async (supplier = 'PadodaTagh') => {
  if (supplier !== 'PadodaTagh') throw retiredSupplierError();
  return padodatagh.getBalance();
};