import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import WhatsAppSupport from './WhatsAppSupport.jsx';

describe('WhatsAppSupport', () => {
  it('links to the Rabs Data support chat with an encoded draft message', () => {
    render(<WhatsAppSupport />);

    const link = screen.getByRole('link', { name: 'Chat with Rabs Data Support on WhatsApp' });
    expect(link).toHaveAttribute(
      'href',
      'https://wa.me/233245342348?text=Hello%20Rabs%20Data%20Support%2C%20I%20need%20assistance%20with%20your%20website.'
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('title', 'Chat with us on WhatsApp');
  });

  it('is keyboard focusable and can sit above the Buy Data action bar', async () => {
    const user = userEvent.setup();
    render(<WhatsAppSupport elevated />);

    await user.tab();

    const link = screen.getByRole('link', { name: 'Chat with Rabs Data Support on WhatsApp' });
    expect(link).toHaveFocus();
    expect(link).toHaveClass('whatsapp-support--elevated');
  });
});