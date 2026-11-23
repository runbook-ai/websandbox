// Fetch every row of a Quaywork ops queue. Run in a signed-in Quaywork page (same origin).
//   const rows = await queueRows('platform-triage');
async function queueRows(slug) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const r = await fetch(`/api/queues/${encodeURIComponent(slug)}/rows?offset=${offset}&limit=100`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`queue rows: HTTP ${r.status}`);
    const d = await r.json();
    rows.push(...d.rows);
    if (!d.rows.length || rows.length >= d.total) return rows;
  }
}
