import env from './environment.js';

const ALL_NETWORKS = [
  { code: 'MTN', label: 'MTN', color: '#FFCC00' },
  { code: 'Telecel', label: 'Telecel', color: '#E60000' },
  { code: 'AirtelTigo', label: 'AirtelTigo', color: '#0057B8' },
];

export const NETWORK_CODES = ALL_NETWORKS.map((network) => network.code);

// ENABLED_NETWORKS in .env (comma separated) controls what customers see.
export const getEnabledNetworks = () =>
  env.enabledNetworks.length
    ? ALL_NETWORKS.filter((network) => env.enabledNetworks.includes(network.code))
    : ALL_NETWORKS;

export const getEnabledNetworkCodes = () => getEnabledNetworks().map((network) => network.code);