// Count Quaywork directory people with API v1. Run in a signed-in Quaywork page.
async function countPeople(city, role) {
  const r = await fetch(`/api/v1/people?city=${encodeURIComponent(city)}&role=${encodeURIComponent(role)}&count=1`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`people: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()).count;
}
