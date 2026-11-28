// Compile the routes once so the end-to-end runs do not wait on first compiles (dev server only).
const BASE = process.env.BASE || 'http://localhost:5031';
const paths = process.argv.slice(2);
for (const p of paths) {
  const t = Date.now();
  try { const r = await fetch(`${BASE}${p}`); console.log(r.status, p, `${Date.now() - t}ms`); } catch (e) { console.log('ERR', p, e.message); }
}
