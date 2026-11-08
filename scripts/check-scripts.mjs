import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
let checked = 0;
for (const file of ['index.html', 'admin.html', 'analytics.html', 'email_resend.html']) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
    if (/type=["']module["']/.test(match[1])) {
      const result = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: match[2], encoding: 'utf8' });
      if (result.status) throw new Error(`${file}: ${result.stderr}`);
    } else new vm.Script(match[2], { filename: file });
    checked++;
  }
}
for (const dir of ['.', 'api', 'scripts', 'tests']) {
  for (const file of await readdir(dir)) {
    if (!/\.(m?js)$/.test(file) || file === 'supabase-browser-config.js') continue;
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
    checked++;
  }
}
console.log(`Syntax verified: ${checked} scripts.`);
