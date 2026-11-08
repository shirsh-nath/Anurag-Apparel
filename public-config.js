// Only public Supabase configuration belongs in the browser.
export async function loadSupabaseConfig() {
  const inline = { url: window.ANURAG_SUPABASE_URL, anonKey: window.ANURAG_SUPABASE_ANON_KEY };
  if (inline.url && inline.anonKey && !inline.url.includes('your_supabase') && !inline.anonKey.includes('your_supabase')) return inline;
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) return {};
    const config = await response.json();
    return { url: config.supabaseUrl, anonKey: config.supabaseAnonKey };
  } catch {
    return {};
  }
}
