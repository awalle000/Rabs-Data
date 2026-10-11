import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Navbar from './Navbar.jsx';

vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: () => ({
    user: null,
    isAdmin: false,
    logout: vi.fn(),
  }),
}));

vi.mock('../../hooks/usePwaInstall.js', () => ({
  usePwaInstall: () => ({
    canInstall: false,
    canShowIOSInstructions: false,
    install: vi.fn(),
    dismiss: vi.fn(),
    isIOS: false,
    isStandalone: false,
    showIOSInstructions: false,
    toggleIOSInstructions: vi.fn(),
  }),
}));

describe('Navbar', () => {
  it('opens the mobile navigation menu when the button is pressed', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: /open navigation menu/i }));

    expect(screen.getByRole('navigation', { name: /mobile menu/i })).toHaveTextContent('Buy Data');
  });
});
