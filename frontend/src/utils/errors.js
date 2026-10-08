export const getErrorMessage = (error, fallback = 'Something went wrong. Please try again.') => {
  if (error?.code === 'ECONNABORTED') {
    return 'The request timed out. Check your connection and try again.';
  }
  if (!error?.response) {
    return error?.request
      ? 'Cannot reach the server. Check your internet connection.'
      : error?.message || fallback;
  }
  return error.response.data?.message || fallback;
};

export const getErrorCode = (error) => error?.response?.data?.code || '';