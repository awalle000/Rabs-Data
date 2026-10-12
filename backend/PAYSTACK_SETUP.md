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

For Google Apps Script, configure these backend-only Render variables:

- `EMAIL_PROVIDER=google-apps-script`
- `GOOGLE_APPS_SCRIPT_URL`: the deployed Apps Script HTTPS web-app URL ending in `/exec`.
- `GOOGLE_APPS_SCRIPT_SECRET`: the same shared secret stored in the script's `RABSDATA_SHARED_SECRET` property. Keep it only in Render's backend environment; never add it to the frontend or Git.
- `CLIENT_URL`: the exact deployed frontend origin, including `https://` and no path. Reset links use this value.

The backend POSTs JSON fields `secret`, `to`, `subject`, `textBody`, and `htmlBody`. It recognizes `{ "ok": true }` as the script reporting success and `{ "ok": false }` as an explicit failure. A timeout, network error, non-2xx status, or malformed response is treated as ambiguous: the active reset token is retained and another reset email is suppressed until token expiry, preventing duplicates if MailApp sent before the response was lost. A script `{ok:true}` response is not proof of inbox delivery.

For SMTP instead, set `EMAIL_PROVIDER=smtp` and configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `EMAIL_FROM`. For Gmail, use `smtp.gmail.com`, port 465 with TLS true, or port 587 with TLS false; authenticate with the full Gmail address and a Google App Password. For Resend, set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, and an `EMAIL_FROM` sender verified by Resend.

For all providers, configure these backend/frontend URL values:

- `CLIENT_URL`: the deployed frontend HTTPS origin. Production startup rejects a missing or non-HTTPS value rather than generating localhost reset links.
- `API_PUBLIC_URL`: the backend's public HTTPS origin. Production startup requires this independently for backend callbacks.
- Frontend hosting: `VITE_API_URL` set to the backend's public origin; the frontend appends `/api`.

Never commit `.env` files or provider credentials. The reset endpoint uses the same generic response regardless of account existence and does not expose delivery outcomes to the client.

## PadodaTagh order callback

The optional callback endpoint for the current Render service is `https://rabs-data.onrender.com/api/webhooks/padodatagh`. Configure this URL in PadodaTagh Developer Settings. The published callback contract documents a JSON POST on `completed` and `rejected` status changes, but does not document a test-button payload, callback signature, or custom authentication header. RabsData therefore treats callbacks only as triggers and verifies the order status with the authenticated PadodaTagh API before changing an order. Empty and synthetic callbacks without a matching submitted merchant reference are acknowledged as ignored and cannot update an order. Keep the PadodaTagh API key backend-only.

After deployment, a safe reachability check is `POST {}` to this URL. It should return HTTP 200 with `received: true` and `ignored: true`; it does not look up or change any order. A malformed non-empty JSON request should return HTTP 400 without a stack trace.