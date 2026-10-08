export const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

export const validateName = (value) => {
  const name = String(value || '').trim();
  if (name.length < 2) return 'Enter your full name';
  if (name.length > 80) return 'Name is too long';
  return '';
};

export const validatePassword = (value) => {
  const password = String(value || '');
  if (password.length < 8) return 'Use at least 8 characters';
  if (password.length > 72) return 'Password is too long';
  if (!/[A-Za-z]/.test(password)) return 'Include at least one letter';
  if (!/\d/.test(password)) return 'Include at least one number';
  return '';
};