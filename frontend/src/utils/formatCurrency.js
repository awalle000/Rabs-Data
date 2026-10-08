const formatter = new Intl.NumberFormat('en-GH', {
  style: 'currency',
  currency: 'GHS',
  minimumFractionDigits: 2,
});

export const formatCurrency = (value) => formatter.format(Number(value) || 0);