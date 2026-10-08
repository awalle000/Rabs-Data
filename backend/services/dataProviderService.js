import * as remadata from './remadataService.js';
import AppError from '../utils/AppError.js';

/*
 * Data provider abstraction layer.
 * Implemented using RemaData as the active supplier.
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

export const isDataProviderConfigured = () => remadata.isConfigured();

export const getAvailablePackages = async (network) => {
  const bundles = await remadata.getBundles(network);
  return bundles.map((bundle) => {
    const net = remadata.fromRemaDataNetwork(bundle.network);
    return {
      network: net,
      providerPackageCode: `${remadata.toRemaDataNetwork(bundle.network)}_${bundle.volumeInMB}`,
      name: bundle.name || `${bundle.volume} Bundle`,
      dataAmount: bundle.volume || `${Number(bundle.volumeInMB) / 1024}GB`,
      volumeInMB: Number(bundle.volumeInMB),
      cost: Number(bundle.price), // Supplier account-specific API price
      description: bundle.description || '',
    };
  });
};

let mockPurchaser = null;
export const setMockPurchaser = (fn) => {
  mockPurchaser = fn;
};

export const purchaseData = async ({
  reference,
  network,
  providerPackageCode,
  dataAmount,
  recipientPhone,
  volumeInMB,
}) => {
  if (mockPurchaser) {
    return mockPurchaser({ reference, network, providerPackageCode, dataAmount, recipientPhone, volumeInMB });
  }
  // Resolve volume in MB: priority is explicit volumeInMB, then fallback to parsing dataAmount
  let resolvedVolume = Number(volumeInMB);
  if (!resolvedVolume || resolvedVolume <= 0) {
    resolvedVolume = remadata.parseVolumeInMB(dataAmount);
  }
  if (!resolvedVolume || resolvedVolume <= 0) {
    if (providerPackageCode && providerPackageCode.includes('_')) {
      const parts = providerPackageCode.split('_');
      resolvedVolume = Number(parts[parts.length - 1]);
    }
  }

  if (!resolvedVolume || resolvedVolume <= 0) {
    const err = new AppError('Could not determine data volume for supplier purchase', 400, 'INVALID_VOLUME');
    err.notSent = true;
    throw err;
  }

  const result = await remadata.buyData({
    ref: reference,
    phone: recipientPhone,
    volumeInMB: resolvedVolume,
    networkType: network,
  });

  return {
    status: result.status, // 'successful' | 'processing' | 'failed'
    supplierStatus: result.supplierStatus, // 'pending' | 'completed' | 'failed' | 'refunded'
    providerReference: result.providerReference,
    clientReference: result.clientReference || reference,
    supplierCost: result.amount,
    refunded: Boolean(result.refunded),
    message: result.message,
  };
};

export const checkTransactionStatus = async ({ reference, providerReference }) => {
  // If we have the supplier reference, query order status endpoint directly
  if (providerReference) {
    try {
      const res = await remadata.getOrderStatus(providerReference);
      return res;
    } catch (err) {
      console.warn(`[dataProvider] getOrderStatus(${providerReference}) failed:`, err.message);
      // Fallback to checking by custom reference if available
    }
  }

  // Lookup by MariData order reference (orderId)
  if (reference) {
    try {
      const supplierOrder = await remadata.getOrderByReference(reference);
      if (supplierOrder) {
        const rawStatus = String(supplierOrder.status || '').toLowerCase();
        let status = 'processing';
        if (rawStatus === 'completed') status = 'successful';
        else if (rawStatus === 'failed') status = 'failed';
        else if (rawStatus === 'refunded') status = 'failed';

        return {
          status,
          supplierStatus: rawStatus,
          providerReference: supplierOrder.reference || supplierOrder.ref_number || providerReference,
          refunded: rawStatus === 'refunded' || Boolean(supplierOrder.refunded),
          message: `Supplier status: ${rawStatus}`,
        };
      }
    } catch (lookupErr) {
      console.warn(`[dataProvider] getOrderByReference(${reference}) failed:`, lookupErr.message);
    }
  }

  return {
    status: 'uncertain',
    supplierStatus: 'uncertain',
    providerReference: providerReference || null,
    refunded: false,
    message: 'Could not determine supplier order status',
  };
};

export const getProviderBalance = async () => {
  return remadata.getWalletBalance();
};

export const verifyWebhookSignature = () => false;

export const parseWebhookEvent = () => null;