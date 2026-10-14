import './WhatsAppSupport.css';

const MESSAGE = 'Hello Rabs Data Support, I need assistance with your website.';
const WHATSAPP_URL = `https://wa.me/233245342348?text=${encodeURIComponent(MESSAGE)}`;

export default function WhatsAppSupport({ elevated = false }) {
  return (
    <a
      className={`whatsapp-support${elevated ? ' whatsapp-support--elevated' : ''}`}
      href={WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with Rabs Data Support on WhatsApp"
      title="Chat with us on WhatsApp"
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path d="M16 4.25a11.75 11.75 0 0 0-10.1 17.74l-1.65 5.76 5.9-1.55A11.75 11.75 0 1 0 16 4.25Z" />
        <path d="M12.1 10.7c-.3-.66-.62-.67-.9-.68h-.77c-.27 0-.7.1-1.07.5-.37.4-1.4 1.37-1.4 3.34s1.44 3.88 1.64 4.15c.2.27 2.78 4.46 6.86 6.07 3.39 1.34 4.08 1.07 4.82 1 .73-.06 2.36-.97 2.7-1.9.34-.94.34-1.74.24-1.9-.1-.17-.37-.27-.77-.47s-2.36-1.17-2.73-1.3c-.37-.14-.64-.2-.9.2-.27.4-1.04 1.3-1.27 1.57-.23.27-.47.3-.87.1-.4-.2-1.69-.62-3.22-1.98-1.19-1.06-1.99-2.37-2.22-2.77-.23-.4-.02-.62.17-.82.17-.17.4-.47.6-.7.2-.24.27-.4.4-.67.14-.27.07-.5-.03-.7-.1-.2-.87-2.17-1.2-2.96Z" />
      </svg>
      <span className="whatsapp-support__tooltip" aria-hidden="true">Chat with us on WhatsApp</span>
    </a>
  );
}