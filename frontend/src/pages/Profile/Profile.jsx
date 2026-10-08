import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import * as authService from '../../services/authService.js';
import { validateName, validatePassword } from '../../utils/validators.js';
import { formatPhone, formatPhoneInput, normalizePhone } from '../../utils/formatPhone.js';
import { getErrorMessage } from '../../utils/errors.js';
import Alert from '../../components/Alert/Alert.jsx';
import './Profile.css';

export default function Profile() {
  const { user, updateUser, logout } = useAuth();
  const navigate = useNavigate();

  const [profile, setProfile] = useState({ name: user.name, phone: formatPhone(user.phone) });
  const [profileMsg, setProfileMsg] = useState(null); // { type, text }
  const [profileErrors, setProfileErrors] = useState({});
  const [savingProfile, setSavingProfile] = useState(false);

  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState(null);
  const [passwordErrors, setPasswordErrors] = useState({});
  const [savingPassword, setSavingPassword] = useState(false);

  const handleProfile = async (event) => {
    event.preventDefault();
    setProfileMsg(null);
    const next = {
      name: validateName(profile.name),
      phone: normalizePhone(profile.phone) ? '' : 'Enter a valid Ghana phone number',
    };
    setProfileErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSavingProfile(true);
    try {
      const response = await authService.updateProfile({ name: profile.name.trim(), phone: normalizePhone(profile.phone) });
      updateUser(response.user);
      setProfileMsg({ type: 'success', text: 'Profile updated.' });
    } catch (err) {
      setProfileMsg({ type: 'error', text: getErrorMessage(err) });
    }
    setSavingProfile(false);
  };

  const handlePassword = async (event) => {
    event.preventDefault();
    setPasswordMsg(null);
    const next = {
      currentPassword: passwords.currentPassword ? '' : 'Enter your current password',
      newPassword: validatePassword(passwords.newPassword),
    };
    setPasswordErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSavingPassword(true);
    try {
      await authService.changePassword(passwords);
      setPasswords({ currentPassword: '', newPassword: '' });
      setPasswordMsg({ type: 'success', text: 'Password changed.' });
    } catch (err) {
      setPasswordMsg({ type: 'error', text: getErrorMessage(err) });
    }
    setSavingPassword(false);
  };

  const handleLogout = () => {
    logout();
    navigate('/', { replace: true });
  };

  return (
    <div className="container page profile">
      <h1 className="page__title">Profile</h1>
      <p className="page__subtitle">{user.email}</p>

      <form className="card" onSubmit={handleProfile} noValidate>
        <h2>Your details</h2>
        {profileMsg && <Alert type={profileMsg.type}>{profileMsg.text}</Alert>}

        <div className="field">
          <label className="field__label" htmlFor="name">
            Full name
          </label>
          <input id="name" className="field__control" autoComplete="name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} aria-invalid={profileErrors.name ? 'true' : 'false'} />
          {profileErrors.name && (
            <span className="field__error" role="alert">
              {profileErrors.name}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="phone">
            Phone number
          </label>
          <input id="phone" type="tel" inputMode="tel" className="field__control" autoComplete="tel" value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: formatPhoneInput(event.target.value) })} aria-invalid={profileErrors.phone ? 'true' : 'false'} />
          {profileErrors.phone && (
            <span className="field__error" role="alert">
              {profileErrors.phone}
            </span>
          )}
        </div>

        <button type="submit" className="btn btn--primary" disabled={savingProfile}>
          {savingProfile ? 'Saving...' : 'Save changes'}
        </button>
      </form>

      <form className="card" onSubmit={handlePassword} noValidate>
        <h2>Change password</h2>
        {passwordMsg && <Alert type={passwordMsg.type}>{passwordMsg.text}</Alert>}

        <div className="field">
          <label className="field__label" htmlFor="currentPassword">
            Current password
          </label>
          <input id="currentPassword" type="password" className="field__control" autoComplete="current-password" value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} aria-invalid={passwordErrors.currentPassword ? 'true' : 'false'} />
          {passwordErrors.currentPassword && (
            <span className="field__error" role="alert">
              {passwordErrors.currentPassword}
            </span>
          )}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="newPassword">
            New password
          </label>
          <input id="newPassword" type="password" className="field__control" autoComplete="new-password" value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} aria-invalid={passwordErrors.newPassword ? 'true' : 'false'} />
          {passwordErrors.newPassword && (
            <span className="field__error" role="alert">
              {passwordErrors.newPassword}
            </span>
          )}
        </div>

        <button type="submit" className="btn btn--primary" disabled={savingPassword}>
          {savingPassword ? 'Saving...' : 'Change password'}
        </button>
      </form>

      <button type="button" className="btn btn--ghost btn--block" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}