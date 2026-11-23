// Book the smallest free meeting room. Run in a signed-in Quaywork page.
async function bookRoom({ date, from, to, size, title }) {
  const q = new URLSearchParams({ date, from, to, size: String(size) });
  const free = await (await fetch(`/api/rooms?${q}`, { headers: { accept: 'application/json' } })).json();
  if (!free.rooms || !free.rooms.length) throw new Error('no free room');
  const room = free.rooms.sort((a, b) => a.size - b.size)[0];
  const token = document.querySelector('meta[name="csrf-token"]').content;
  const r = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/bookings`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ date, from, to, title }) });
  if (!r.ok) throw new Error(`booking: HTTP ${r.status}`);
  return room;
}
