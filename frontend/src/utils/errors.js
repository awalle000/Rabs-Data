export const getErrorMessage = (error, fallback = 'Something went wrong. Please try again.') => {
  if (error?.code === 'ECONNABORTED') {
    return 'The server is taking longer than expected to respond. Please try again.';
  }

  if (!error?.response) {
    if (error?.message === 'Network Error') {
      return 'The server is not responding yet. Please wait while it wakes up or try again in a moment.';
    }
    if (error?.request) {
      return 'The server is taking longer than expected to respond. Please try again.';
    }
    return error?.message || fallback;
  }

  const { status, data } = error.response;

  if (status === 401) return data?.message || 'Your session has expired. Please log in again.';
  if (status === 403) return data?.message || 'You do not have permission to perform this action.';
  if (status === 404) return data?.message || 'This resource was not found.';
  if (status >= 500) return data?.message || 'The server encountered an error. Please try again later.';

  return data?.message || fallback;
};

export const getErrorCode = (error) => error?.response?.data?.code || '';