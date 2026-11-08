// Read-only diagnostic. Never print keys, tokens, or provider secrets.
import { readFile } from 'node:fs/promises';
const values = {};
for (const line of (await readFile('.env', 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (match) values[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const response = await fetch(`${values.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: values.SUPABASE_ANON_KEY } });
if (!response.ok) throw new Error(`Auth settings HTTP ${response.status}`);
const settings = await response.json();
console.log(JSON.stringify({ googleEnabled: settings.external?.google, signupDisabled: settings.disable_signup }));
