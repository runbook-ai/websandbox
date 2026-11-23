// Quaywork account record via API v1. Run in a signed-in Quaywork page.
async function account(id) {
  const r = await fetch(`/api/v1/accounts/${id}`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`account: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}
