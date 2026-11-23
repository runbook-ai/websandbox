// Quaywork channel history via API v1. Run in a signed-in Quaywork page.
async function history(channel, since) {
  const r = await fetch(`/api/v1/channels/${encodeURIComponent(channel)}/history?since=${since}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`history: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).items;
}
