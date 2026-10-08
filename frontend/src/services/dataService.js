import api from './api.js';

export const getNetworks = () => api.get('/data/networks').then((res) => res.data);

export const getPackages = (network) =>
  api.get('/data/packages', { params: network ? { network } : undefined }).then((res) => res.data);

// Networks and packages together, for the home and buy pages.
export const getCatalog = async () => {
  const [networks, packages] = await Promise.all([getNetworks(), getPackages()]);
  return { networks: networks.networks, packages: packages.packages };
};