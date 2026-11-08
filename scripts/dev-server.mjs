import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = {};
try {
  for (const line of (await readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const aliases = { '/': '/index.html', '/admin': '/admin.html', '/analytics': '/analytics.html', '/email': '/email_resend.html', '/privacy': '/privacy.html', '/privacy/': '/privacy.html', '/terms': '/terms.html', '/terms/': '/terms.html' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL || env.SUPABASE_URL || null, supabaseAnonKey: process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || null, maxVideoMb: 50 }));
      return;
    }
    // Serve only frontend assets. Never serve dotfiles, source scripts, SQL or secrets.
    const asset = aliases[pathname] || pathname;
    const allowed = /^\/(?:index\.html|admin\.html|analytics\.html|email_resend\.html|privacy\.html|terms\.html|legal\.css|supabase-browser-config\.js|public-config\.js|customer-account\.(?:js|css)|Images\/[^\\]+)$/i.test(asset);
    if (!allowed || asset.split('/').some(part => part.startsWith('.') || part === '..')) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = path.resolve(root, `.${asset}`);
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(404).end('Not found');
      return;
    }
    const body = await readFile(file);
    res.setHeader('Content-Type', mime[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.listen(Number(process.env.PORT || 5500), '127.0.0.1', () => {
  console.log(`Local storefront: http://localhost:${server.address().port}`);
});
