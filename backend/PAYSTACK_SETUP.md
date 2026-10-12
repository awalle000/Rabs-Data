# Paystack Setup

## Backend environment

Set these in the backend's Render environment, not in Vercel or any `VITE_*` variable:

- `PAYSTACK_SECRET_KEY`: the secret key for the Paystack mode selected in the dashboard. Keep it private; the backend uses it for initialization, verification, and webhook signatures.
- `PAYSTACK_GUEST_EMAIL`: a real, monitored business email address for guests who leave the checkout email blank. Paystack requires an email and sends its receipt to this address; customers who enter an email use their own instead.
- `API_PUBLIC_URL`: the public HTTPS base URL of the deployed backend, without a trailing slash. This is used to construct the webhook URL.
- `CLIENT_URL`: the deployed frontend origin (or comma-separated allowed origins where the environment supports multiple frontend URLs).
- `MONGODB_URI`: the existing MongoDB connection string; payment references and pending state are persisted there before contacting Paystack.
- `JWT_SECRET`: the existing production authentication secret.

`PAYSTACK_BASE_URL` is optional and defaults to `https://api.paystack.co`. Keep the default for normal use. The Hubtel variables in `.env.example` are only for verification of historical Hubtel transactions and callbacks; they do not initialize new payments.

## Paystack dashboard

1. Select the same test or live mode as the `PAYSTACK_SECRET_KEY` configured on Render.
2. Confirm the Paystack account is enabled for GHS transactions and for the payment channels you intend to offer.
3. Set the webhook URL to `https://<API_PUBLIC_URL>/api/payments/webhook/paystack` (replace the placeholder with the backend's actual public host). The endpoint consumes the raw request body and verifies `x-paystack-signature` with the backend secret.
4. Enable the `charge.success` event. The callback is only a signal: the backend verifies the transaction through Paystack before changing an order or wallet balance.

Do not put the secret key in frontend code, Vercel environment variables, browser requests, or logs. A browser return to RabsData does not itself confirm a payment; the order or wallet remains pending until server-side verification succeeds.

## Password-reset email deployment

On Render, configure these backend environment variables:

- `CLIENT_URL`: the exact deployed frontend origin, including `https://` and no path (for example, `https://www.example.com`). Production startup rejects a missing or non-HTTPS value so reset links cannot silently point to localhost.
- `EMAIL_PROVIDER=resend`: selects the HTTPS Resend API, which avoids relying on outbound SMTP connectivity from the host.
- `RESEND_API_KEY`: a private Resend API key. Keep it only in Render's backend environment.
- `EMAIL_FROM`: a sender address/domain verified in Resend, such as `Rabs Data <security@your-verified-domain.com>`.

If using SMTP instead, set `EMAIL_PROVIDER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`. For Gmail, use an app password from an account with 2-Step Verification enabled, and ensure the sender is authorized for that mailbox. Do not use the account's normal Gmail password. Delivery errors are logged by safe error code only; reset tokens are invalidated when delivery fails.

In the frontend hosting service, set `VITE_API_URL` to the backend's public origin (for example, `https://your-api.onrender.com`). The frontend appends `/api`. The backend's `CLIENT_URL` must match that frontend origin exactly for CORS.

Never commit `.env` files or email provider credentials. A successful API response is enumeration-safe and does not claim delivery; users are told a link will be sent only when delivery is available.

## PadodaTagh order callback

The optional callback endpoint for the current Render service is `https://rabs-data.onrender.com/api/webhooks/padodatagh`. Configure this URL in PadodaTagh Developer Settings. The published callback contract documents a JSON POST on `completed` and `rejected` status changes, but does not document a test-button payload, callback signature, or custom authentication header. RabsData therefore treats callbacks only as triggers and verifies the order status with the authenticated PadodaTagh API before changing an order. Empty and synthetic callbacks without a matching submitted merchant reference are acknowledged as ignored and cannot update an order. Keep the PadodaTagh API key backend-only.

After deployment, a safe reachability check is `POST {}` to this URL. It should return HTTP 200 with `received: true` and `ignored: true`; it does not look up or change any order. A malformed non-empty JSON request should return HTTP 400 without a stack trace.