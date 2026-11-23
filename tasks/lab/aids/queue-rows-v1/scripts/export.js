// Export a Quaywork queue with API v1. Run in a signed-in Quaywork page.
//   const tickets = await exportQueue('platform-triage');
async function exportQueue(slug) {
  const r = await fetch(`/api/v1/queues/${encodeURIComponent(slug)}/tickets`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`export: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).tickets;
}
