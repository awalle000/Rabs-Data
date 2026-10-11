import api from './api.js';

export const getNetworks = () => api.get('/data/networks').then((res) => res.data);

export const getPackages = (network) =>
  api.get('/data/packages', { params: network ? { network } : undefined }).then((res) => res.data);

let catalogRequest;

// Share only an in-flight request; each completed call gets a fresh server snapshot.
export const getCatalog = () => {
  if (!catalogRequest) {
    catalogRequest = api.get('/data/catalog')
      .then((res) => res.data)
      .catch(async (error) => {
        if (error.response?.status !== 404) throw error;
        const [networks, packages] = await Promise.all([getNetworks(), getPackages()]);
        return { networks: networks.networks, packages: packages.packages, count: packages.count };
      })
      .finally(() => { catalogRequest = null; });
  }
  return catalogRequest;
};