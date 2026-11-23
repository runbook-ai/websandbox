// Health figures of a Quaywork CRM account. Run in a signed-in Quaywork page:
//   const m = await accountMetrics(17);   // {arr, health, seatsUsed, seatsTotal, renewal, nps}
async function accountMetrics(id) {
  const r = await fetch(`/api/accounts/${id}/metrics`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`metrics: HTTP ${r.status}`);
  return (await r.json()).metrics;
}
