# Customer accounts: Google OAuth setup

Customer accounts were introduced on `feature/online-order-accounts`. The current
`feature/online-order-commerce` extends those accounts with COD checkout and order
history; see [the commerce setup and rollout guide](online-orders.md). Pushing the
commerce branch does not merge or publish its frontend to the production website.
The customer-profile schema remains an additive part of the shared Supabase project.

## Required console configuration

The previous account setup recorded Google as enabled on 2026-11-08. The Google client credentials,
production Site URL, and the three return URLs below were configured through the
Supabase Management API using the locally supplied personal access token. Nonce
checks remain enabled, and signup is allowed. The token is only needed for setup;
it is not sent to the frontend or required by the storefront at runtime.

That setup verification confirmed Google was enabled at the public Auth endpoint and all three
return URLs receive a 302 redirect to Google with the correct client ID and Supabase
callback. **The Google callback registration is now accepted:** the authorization
request reached Google's `/v3/signin/identifier` page with no `redirect_uri_mismatch`
or OAuth error page. Recheck these settings if credentials or domains change. Real-account Google consent,
the return to the storefront, and saving a customer profile still need an end-to-end
test in a browser.

1. Open the existing web OAuth client in Google Cloud Console. Keep the JavaScript
   origins already configured: `http://localhost:5500`,
   `https://anuragapparel.in`, and `https://www.anuragapparel.in`.
2. **Completed:** Under **Authorized redirect URIs**, add exactly:

   ```text
   https://imclnhkuusypelcmwogt.supabase.co/auth/v1/callback
   ```

   This is the Supabase callback, not the storefront address.
3. **Completed:** In [Supabase Auth → Sign In / Providers](https://supabase.com/dashboard/project/imclnhkuusypelcmwogt/auth/providers),
   enable Google. Copy `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
   from your local `.env` to the provider's Client IDs and Client Secret fields.
   Keep nonce checks enabled. Do not add the secret to frontend code or `/api/config`.
4. **Completed:** In [Supabase Auth → URL Configuration](https://supabase.com/dashboard/project/imclnhkuusypelcmwogt/auth/url-configuration),
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
6. The website includes public Privacy Policy and Terms of Service pages. After the
   feature branch is deployed to the production domain, set these in Google Auth
   Platform → Branding → App domain:

   ```text
   Application privacy policy link: https://www.anuragapparel.in/privacy
   Application terms of service link: https://www.anuragapparel.in/terms
   ```

   Check both public URLs before adding them. A GitHub branch push alone does not
   confirm that the pages are available on the production domain. Both links also
   appear in the storefront footer and Google sign-in dialog. See
   [Google's branding instructions](https://support.google.com/cloud/answer/15549049?hl=en).

Supabase documentation: [Google login](https://supabase.com/docs/guides/auth/social-login/auth-google),
[redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls),
[PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow).

## Local verification

Run `npm run dev`, then visit `http://localhost:5500`. The development server reads
`.env` privately and serves only public Supabase configuration at `/api/config`.
Do not serve the repository root with a generic Live Server while secrets exist:
removing frontend `.env` requests does not stop such a server exposing that file.

Run `npm run check` and `npm test`. Run `sql/tests/customer-profiles.sql` in the SQL
editor for transactional database access tests; all synthetic fixtures roll back.
`node scripts/inspect-auth.mjs` checks whether Google is enabled without printing secrets.

With the Google callback accepted, manually verify Google consent, account completion,
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

Commerce orders reference the stable Auth user UUID and require a completed
customer profile. Checkout collects a separate delivery recipient, contact phone,
full address and map point. Prices, inventory and delivery rules are verified by
the server, and customers can read only their own visible orders/items/events.
Customer profile updates do not rewrite past order snapshots.

## Commerce security activation

The historical admin uses password RPCs while catalogue, media and marketing
operations have anonymous-write policies. The commerce branch replaces that
boundary with server-validated opaque staff sessions, session-checked database
policies, signed media writes and private marketing/analytics access. It also
removes anonymous access to the analytics purge RPC. Customer sign-in never grants
staff authority, and editable Google user metadata is not used for authorization.

Apply `sql/commerce-schema.sql` additively first. Ordering remains sealed/off.
Apply `sql/commerce-security.sql` only alongside deployment of the branch's
new admin frontend and updated legacy Edge Functions. Activation accepts the
configured administrator credential without requiring a password change. Later
password changes revoke existing sessions. This deliberately makes old admin
clients stop writing. See [the coordinated rollout](online-orders.md#installation-and-coordinated-rollout)
before enabling ordering. Do not reapply the historical base permissions after
commerce activation.

The repository previously tracked `.env`. This branch stops tracking it and excludes
secrets from Vercel uploads, while preserving your local file. Old Git history is
unchanged; rotate any credentials that were pushed in earlier commits. Do not run
the entire historical schema on a live database just to add profiles: use only the
new customer-accounts section (already applied to the connected project).
