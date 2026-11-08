# Customer accounts: Google OAuth setup

This feature is on `feature/online-order-accounts`. It does not add checkout or
publish the branch to the production website. The customer profile schema is an
additive change on the existing shared Supabase project; it does not contain orders.

## Required console configuration

Google is currently disabled in the project's Supabase Auth settings. The `.env`
credentials alone do not enable the hosted Supabase provider. The connector supports
database changes but not provider settings, and no browser session was available
to configure the consoles during implementation.

1. Open the existing web OAuth client in Google Cloud Console. Keep the JavaScript
   origins already configured: `http://localhost:5500`,
   `https://anuragapparel.in`, and `https://www.anuragapparel.in`.
2. Under **Authorized redirect URIs**, add exactly:

   ```text
   https://imclnhkuusypelcmwogt.supabase.co/auth/v1/callback
   ```

   This is the Supabase callback, not the storefront address.
3. In [Supabase Auth → Sign In / Providers](https://supabase.com/dashboard/project/imclnhkuusypelcmwogt/auth/providers),
   enable Google. Copy `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
   from your local `.env` to the provider's Client IDs and Client Secret fields.
   Keep nonce checks enabled. Do not add the secret to frontend code or `/api/config`.
4. In [Supabase Auth → URL Configuration](https://supabase.com/dashboard/project/imclnhkuusypelcmwogt/auth/url-configuration),
   preserve any existing application redirects. Set Site URL to
   `https://www.anuragapparel.in` and add these exact Redirect URLs:

   ```text
   http://localhost:5500/?account=1
   https://anuragapparel.in/?account=1
   https://www.anuragapparel.in/?account=1
   ```

   For a Vercel feature preview, add that specific preview origin with
   `/?account=1`. Avoid broad production wildcard redirects.
5. Keep the Google app in Testing for this phase. If Google requires test-user
   access for your consent-screen configuration, add the accounts you will test.
   Only request `openid email profile`; no offline Google access is needed.

Supabase documentation: [Google login](https://supabase.com/docs/guides/auth/social-login/auth-google),
[redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

## Local verification

Run `npm run dev`, then visit `http://localhost:5500`. The development server reads
`.env` privately and serves only public Supabase configuration at `/api/config`.
Do not serve the repository root with a generic Live Server while secrets exist:
removing frontend `.env` requests does not stop such a server exposing that file.

Run `npm run check` and `npm test`. Run `tests/customer-profiles.sql` in the SQL
editor for transactional database access tests; all synthetic fixtures roll back.
`node scripts/inspect-auth.mjs` checks whether Google is enabled without printing secrets.

After enabling the provider, manually verify Google consent, account completion,
profile persistence after reload, editing, sign-out, a second Google account, canceling
consent, and keyboard/mobile dialog behavior. Stay on the same browser and origin
through the PKCE flow. Automated tests cover account behavior with a mocked SDK;
they cannot substitute for a real Google login.

## Data and access

- Supabase Auth holds the stable UUID, Google identity, and verified email.
- `public.customer_profiles` holds name, E.164 phone, and server timestamps.
- Customer input is validated in the browser and database. Names and phone numbers
  are customer-supplied; the phone is not OTP verified.
- Authenticated users can select/insert/update only the profile matching `auth.uid()`.
  They cannot access other profiles, delete records, or write timestamps.
- Profiles are saved after contact details are completed. A Google identity without
  a profile is prompted to complete it on the next sign-in.
- No auth.users trigger is added, avoiding profile errors blocking Google signup.
- Customer sessions use `anurag-customer-auth`; the catalog uses a nonpersistent
  anonymous client and cannot consume an OAuth callback or inherit customer tokens.
- Customer profiles are separate from the existing marketing email-contact table.
  No customer is automatically enrolled in marketing emails.

Future orders should reference `customer_profiles.id`. Delivery address and order
details should be collected during checkout, with server-verified prices and owner
policies on orders and line items.

## Existing security follow-up before checkout

The legacy admin uses password RPCs while catalog, media and marketing operations
remain allowed to the anonymous database role. These existing policies are not an
authorization boundary for a transactional store. Replace them with authenticated
admin roles and server-authorized operations before introducing orders/payments.
Customer profile policies do not grant any additional catalog/admin permissions.
The Supabase advisor also flags the existing `public.purge_old_analytics_events()`
function as callable by anonymous and authenticated users with definer privileges;
see [the advisor remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).
No new customer-profile advisor findings were reported.

The repository previously tracked `.env`. This branch stops tracking it and excludes
secrets from Vercel uploads, while preserving your local file. Old Git history is
unchanged; rotate any credentials that were pushed in earlier commits. Do not run
the entire historical schema on a live database just to add profiles: use only the
new customer-accounts section (already applied to the connected project).
