import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('development server serves storefront/assets and blocks credentials and source', async t => {
  const child = spawn(process.execPath, ['scripts/dev-server.mjs'], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Development server did not start')), 10000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.stderr.once('data', data => { clearTimeout(timeout); reject(new Error(data.toString())); });
    child.stdout.on('data', data => {
      const match = data.toString().match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
    });
  });
  for (const asset of ['/', '/customer-account.js', '/customer-account.css', '/public-config.js', '/admin-session.js', '/commerce-client.js', '/storefront-commerce.js', '/storefront-commerce.css', '/orders-admin.js', '/orders-admin.css', '/orders-admin-logic.js', '/orders', '/orders.html', '/orders/', '/admin', '/analytics', '/email', '/privacy', '/privacy/', '/privacy.html', '/terms', '/terms/', '/terms.html', '/legal.css']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
  }
  for (const secret of ['/.env', '/.env.example', '/credential.txt', '/.git/config', '/supabase-schema.sql', '/sql/supabase-schema.sql', '/sql/commerce-schema.sql', '/sql/tests/commerce.sql', '/scripts/inspect-auth.mjs', '/Images/../.env']) {
    assert.equal((await fetch(base + secret)).status, 404, secret);
  }
  const response = await fetch(base + '/api/config');
  const config = await response.json();
  assert.deepEqual(Object.keys(config).sort(), ['maxVideoMb', 'supabaseAnonKey', 'supabaseUrl']);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(config), /GOOGLE_OAUTH_CLIENT_SECRET|RESEND_API_KEY|APIFY_API_KEY/);
});
