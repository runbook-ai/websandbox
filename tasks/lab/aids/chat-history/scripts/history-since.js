// Every message of a Quaywork channel posted on or after isoDate (YYYY-MM-DD, UTC), oldest first.
// Run in a signed-in Quaywork page:  const ms = await messagesSince('design-review', '2026-03-02');
async function messagesSince(channel, isoDate) {
  const out = [];
  let before = '';
  for (;;) {
    const r = await fetch(`/api/chat/${encodeURIComponent(channel)}/messages?limit=50${before}`, { headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`chat history: HTTP ${r.status}`);
    const d = await r.json();
    out.unshift(...d.messages);
    if (!d.hasMore || !d.messages.length || d.messages[0].day < isoDate) break;
    before = `&before=${d.messages[0].id}`;
  }
  return out.filter((m) => m.day >= isoDate);
}
