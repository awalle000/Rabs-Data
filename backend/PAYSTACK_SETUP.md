# Paystack Setup

## Backend environment

Set these in the backend's Render environment, not in Vercel or any `VITE_*` variable:

- `PAYSTACK_SECRET_KEY`: the secret key for the Paystack mode selected in the dashboard. Keep it private; the backend uses it for initialization, verification, and webhook signatures.
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

## PadodaTagh order callback

The optional callback endpoint for the current Render service is `https://rabs-data.onrender.com/api/webhooks/padodatagh`. Configure this URL in PadodaTagh Developer Settings. The published callback contract documents a JSON POST on `completed` and `rejected` status changes, but does not document a test-button payload, callback signature, or custom authentication header. RabsData therefore treats callbacks only as triggers and verifies the order status with the authenticated PadodaTagh API before changing an order. Empty and synthetic callbacks without a matching submitted merchant reference are acknowledged as ignored and cannot update an order. Keep the PadodaTagh API key backend-only.

After deployment, a safe reachability check is `POST {}` to this URL. It should return HTTP 200 with `received: true` and `ignored: true`; it does not look up or change any order. A malformed non-empty JSON request should return HTTP 400 without a stack trace.