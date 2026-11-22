'use strict';
// Email addresses for world entities, shared by the renderer (headers shown to the LLM) and the mail
// site build (rows), so text and data agree. A persona writes from their work address to colleagues
// and from their personal address otherwise.
const PERSONAL_DOMAIN = 'inboxmail.example';

const localPart = (name) => name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.');
const slugDomain = (name) => `${name.toLowerCase().replace(/[^a-z]+/g, '')}.example`;

function mailAddr(world, personaById) {
  const emp = new Map(world.employers.map((e) => [e.id, e]));
  const nl = new Map(world.newsletters.map((n) => [n.id, n]));
  // -> { name, email, kind, org? }
  return function addr(id, otherId) {
    if (id.startsWith('nl-')) { const n = nl.get(id); return { name: n.name, email: `issues@${slugDomain(n.name)}`, kind: 'list', org: n.name }; }
    if (id.startsWith('vendor:')) { const c = id.slice(7); return { name: `${c} Sales`, email: `sales@${slugDomain(c)}`, kind: 'vendor', org: c }; }
    const p = personaById.get(id), o = otherId && personaById.get(otherId);
    const work = p.employer && o && p.employer === o.employer ? emp.get(p.employer) : null;
    return { name: p.name, email: `${localPart(p.name)}@${work ? work.domain : PERSONAL_DOMAIN}`, kind: 'person', org: work ? work.name : null, persona: p.id };
  };
}

const fmtAddr = (a) => `${a.name} <${a.email}>`;

module.exports = { mailAddr, fmtAddr, localPart, PERSONAL_DOMAIN };
