# Administrator Web Push

Web Push is separate from PadodaTagh SMS and Paystack. The existing PWA manifest and custom offline service worker are retained; no Vercel environment variable or service-worker plugin is required.

## Render configuration

Generate a VAPID pair locally from the `backend` directory using the installed `web-push` package:

```sh
npx web-push generate-vapid-keys
```

In the Render backend service, open **Environment** and add these exact variables using the generated output:

- `VAPID_PUBLIC_KEY`: generated public key. The authenticated admin status endpoint returns this public value to the frontend for device subscription.
- `VAPID_PRIVATE_KEY`: matching generated private key. Backend only; never put it in Vercel, frontend source, or a `VITE_` variable.
- `VAPID_SUBJECT`: a contact URI, preferably `mailto:you@example.com` using an address you monitor.

Save the variables and allow Render's normal deployment/restart to apply them. Do not reuse a key pair from another application, and do not commit either generated value. Changing the pair later requires administrators to subscribe their devices again.

## Enabling a device

Sign in with an administrator account, open the admin dashboard, and click **Enable Admin Notifications**. Grant the browser's notification permission when prompted. Use **Send test** to send a test push to the current administrator's subscribed devices; it does not create an order or financial activity. **Disable this device** removes only the current browser's subscription.

Notification sounds and presentation are controlled by the operating system and browser. Android Chrome and supported desktop browsers can receive push while the site is not open, subject to device/network power settings. On iPhone and iPad, install RabsData to the Home Screen, open that installed web app, and grant notification permission there; iOS web push requires a Home Screen web app on supported iOS versions. Silent mode, Focus/Do Not Disturb, and notification preferences are respected.

The endpoint has not been tested against a deployed Render service or a real phone until VAPID values are configured and the test action is performed on that device.