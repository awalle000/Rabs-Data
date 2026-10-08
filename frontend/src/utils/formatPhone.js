const GHANA_PHONE = /^0(20|23|24|25|26|27|28|50|53|54|55|56|57|59)\d{7}$/;

// 024 123 4567, +233241234567 and 233241234567 all become 0241234567 (or null).
export const normalizePhone = (input) => {
  if (typeof input !== 'string') return null;
  let digits = input.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+233')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('233')) digits = `0${digits.slice(3)}`;
  return GHANA_PHONE.test(digits) ? digits : null;
};

// Shows 0241234567 as "024 123 4567".
export const formatPhone = (value) => {
  const digits = String(value || '');
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
};

// Live formatting while the user types.
export const formatPhoneInput = (raw) => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+') || trimmed.replace(/\D/g, '').startsWith('233')) {
    return trimmed.replace(/[^\d+]/g, '').slice(0, 13);
  }
  const digits = trimmed.replace(/\D/g, '').slice(0, 10);
  if (digits.length > 6) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  if (digits.length > 3) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return digits;
};

const PREFIXES = {
  MTN: ['024', '025', '053', '054', '055', '059'],
  Telecel: ['020', '050'],
  AirtelTigo: ['026', '027', '056', '057'],
};

// A soft hint only. Number portability means prefixes are not proof.
export const detectNetwork = (phone) => {
  const normalized = normalizePhone(phone || '');
  if (!normalized) return null;
  const prefix = normalized.slice(0, 3);
  return Object.keys(PREFIXES).find((network) => PREFIXES[network].includes(prefix)) || null;
};