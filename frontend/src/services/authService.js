import api from './api.js';

export const register = (payload) => api.post('/auth/register', payload).then((res) => res.data);
export const login = (payload) => api.post('/auth/login', payload).then((res) => res.data);
export const getMe = () => api.get('/auth/me').then((res) => res.data);
export const updateProfile = (payload) => api.put('/users/profile', payload).then((res) => res.data);
export const changePassword = (payload) => api.put('/users/password', payload).then((res) => res.data);
export const forgotPassword = (payload) => api.post('/auth/forgot-password', payload).then((res) => res.data);
export const verifyResetToken = (token) => api.get(`/auth/reset-password/${token}`).then((res) => res.data);
export const resetPassword = (token, payload) => api.post(`/auth/reset-password/${token}`, payload).then((res) => res.data);