import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as authService from '../services/authService.js';
import { TOKEN_KEY } from '../services/api.js';
import { local, session } from '../utils/storage.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(local.get(TOKEN_KEY)));

  // Restore the session if a token is saved. Guests skip this entirely.
  useEffect(() => {
    if (!local.get(TOKEN_KEY)) return undefined;
    let active = true;
    authService
      .getMe()
      .then((data) => active && setUser(data.user))
      .catch(() => {
        /* A 401 already cleared the token. A network error keeps it for next time. */
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onExpired = () => {
      local.remove('maridata_guest_orders');
      session.remove('maridata_order_draft');
      setUser(null);
    };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const persist = useCallback((data) => {
    local.set(TOKEN_KEY, data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const login = useCallback(async (credentials) => persist(await authService.login(credentials)), [persist]);
  const register = useCallback(async (payload) => persist(await authService.register(payload)), [persist]);

  const logout = useCallback(() => {
    local.remove(TOKEN_KEY);
    // Clear guest order tracking tokens so they don't leak to the next user
    // who logs in on the same browser.
    local.remove('maridata_guest_orders');
    // Clear the in-progress checkout draft (network/package/phone selection)
    // so a new user doesn't see the previous user's recipient phone number.
    session.remove('maridata_order_draft');
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      isAdmin: user?.role === 'admin',
      login,
      register,
      logout,
      updateUser: setUser,
    }),
    [user, loading, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
};