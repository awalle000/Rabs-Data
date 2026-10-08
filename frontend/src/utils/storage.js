// Storage can be blocked (private mode, strict settings). These never throw.
const make = (getStore) => ({
  get(key, fallback = null) {
    try {
      const value = getStore().getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      getStore().setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: the app still works, it just won't remember */
    }
  },
  remove(key) {
    try {
      getStore().removeItem(key);
    } catch {
      /* ignore */
    }
  },
});

export const local = make(() => window.localStorage);
export const session = make(() => window.sessionStorage);