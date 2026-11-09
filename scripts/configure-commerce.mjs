// Run locally from the repository root. Credentials are read from the ignored .env.
// Never send COMMERCE_CODE_KEY to PostgreSQL or print secret values.
import { readFile, appendFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

const values = {};
for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
  if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const projectUrl = new URL(values.SUPABASE_URL);
const ref = projectUrl.hostname.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
if (!ref || !values.SUPABASE_ACCESS_TOKEN) throw new Error('Saved SUPABASE_URL and SUPABASE_ACCESS_TOKEN are required.');
const endpoint = `https://api.supabase.com/v1/projects/${ref}`;
async function management(path, method = 'GET', body) {
  const result = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${values.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!result.ok) throw new Error(`Management API ${method} ${path}: HTTP ${result.status}`);
  const raw = await result.text();
  return raw ? JSON.parse(raw) : null;
}
let secrets = await management('/secrets');
if (!Array.isArray(secrets)) throw new Error('Unexpected secret inventory response.');
const names = ['COMMERCE_CODE_KEY', 'COMMERCE_MAINTENANCE_KEY'];
// The Management API returns SHA-256 digests in the value field.
const digest = item => item?.digest || item?.value;
if (process.argv.includes('--secrets')) {
  const pending = [];
  // Verify both existing keys before making changes; never silently rotate them.
  for (const name of names) {
    const remote = secrets.find(item => item.name === name);
    const local = values[name];
    if (remote && !local) throw new Error(`${name} exists remotely. Restore its original value from your private backup before configuring; do not rotate an active delivery-code key.`);
    if (local && !/^[A-Za-z0-9_-]{43}$/.test(local)) throw new Error(`${name} must be a 32-byte base64url key.`);
    if (remote && digest(remote) !== createHash('sha256').update(local).digest('hex')) throw new Error(`${name} differs from the saved value. Refusing to overwrite an existing server key.`);
  }
  for (const name of names) {
    if (!values[name]) {
      values[name] = randomBytes(32).toString('base64url');
      await appendFile('.env', `\n${name}=${values[name]}\n`);
    }
    if (!secrets.some(item => item.name === name)) pending.push({ name, value: values[name] });
  }
  for (const name of ['RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
    if (!secrets.some(item => item.name === name) && values[name]) pending.push({ name, value: values[name] });
  }
  if (pending.length) await management('/secrets', 'POST', pending);
  secrets = await management('/secrets');
  if (!names.every(name => secrets.some(item => item.name === name && digest(item) === createHash('sha256').update(values[name]).digest('hex')))) throw new Error('Commerce secret verification failed.');
  console.log('Commerce server secrets verified. New keys, if generated, are saved only in the ignored local .env.');
}
if (process.argv.includes('--schedule-config')) {
  const remote = secrets.find(item => item.name === 'COMMERCE_MAINTENANCE_KEY');
  if (!values.COMMERCE_MAINTENANCE_KEY || !remote || digest(remote) !== createHash('sha256').update(values.COMMERCE_MAINTENANCE_KEY).digest('hex')) throw new Error('Verify the maintenance key with --secrets first.');
  const literal = value => "'" + value.replace(/'/g, "''") + "'";
  // Only the scoped maintenance token enters Vault, never the delivery-code key.
  const vaultValues = { commerce_maintenance_key: values.COMMERCE_MAINTENANCE_KEY, commerce_project_url: projectUrl.origin };
  for (const [name, value] of Object.entries(vaultValues)) {
    await management('/database/query', 'POST', { query: `do $setup$ declare secret_id uuid; begin select id into secret_id from vault.secrets where name=${literal(name)}; if secret_id is null then perform vault.create_secret(${literal(value)},${literal(name)}); else perform vault.update_secret(secret_id,${literal(value)},${literal(name)}); end if; end $setup$;` });
  }
  console.log('Maintenance-only Vault configuration saved. Apply supabase/commerce-maintenance.sql to schedule it.');
}
console.log(JSON.stringify({ project: ref, commerceCodeKeyConfigured: secrets.some(item => item.name === names[0]), maintenanceKeyConfigured: secrets.some(item => item.name === names[1]), resendConfigured: ['RESEND_API_KEY', 'RESEND_FROM_EMAIL'].every(name => secrets.some(item => item.name === name)) }));
