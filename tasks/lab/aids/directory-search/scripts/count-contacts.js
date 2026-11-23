// Count Quaywork directory contacts by exact city and role (API v2). Run in a signed-in Quaywork page:
//   await countContacts({ city: 'Port Ellery', role: 'Buyer' })
async function directoryAll(q = '') {
  const out = [];
  for (let cursor = 0; cursor !== null;) {
    const r = await fetch(`/api/v2/directory?limit=50&cursor=${cursor}&q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`directory: HTTP ${r.status}`);
    const d = await r.json();
    out.push(...d.contacts);
    cursor = d.nextCursor;
  }
  return out;
}
async function countContacts({ city, role }) {
  const all = await directoryAll(city || '');
  return all.filter((c) => (!city || c.city === city) && (!role || c.role === role)).length;
}
