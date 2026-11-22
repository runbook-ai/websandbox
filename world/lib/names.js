'use strict';
// Invented names for things that must not collide with real brands: projects, products, companies,
// venues, newsletters. Built from syllables + common words, so they read as plausible but are made up.
const ON = ['br', 'cl', 'dr', 'f', 'gl', 'k', 'l', 'm', 'n', 'p', 'qu', 'r', 's', 'st', 't', 'tr', 'v', 'z', 'h', 'j'];
const NU = ['a', 'e', 'i', 'o', 'u', 'ai', 'ea', 'io', 'ou', 'y'];
const CO = ['b', 'd', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'x', 'v', 'nd', 'nt', 'rk', 'sh', 'ck'];
const WORDS = ['pine', 'harbor', 'maple', 'cedar', 'iron', 'copper', 'river', 'north', 'bright', 'little', 'blue', 'stone', 'field', 'oak', 'silver', 'lantern', 'meadow', 'summit', 'bay', 'orchard', 'willow', 'granite', 'echo', 'kite', 'sparrow', 'thistle', 'juniper', 'ember', 'tidal', 'quarry'];
const TECH_SUFFIX = ['js', 'db', 'kit', 'flow', 'ly', 'hub', 'stack', 'base', 'lab', 'ops'];
const BIZ_SUFFIX = ['Labs', 'Works', 'Studio', 'Supply', 'Collective', 'Partners', 'Group', 'Co.'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function syllables(r, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += r.pick(ON) + r.pick(NU) + (i === n - 1 || r.chance(0.4) ? r.pick(CO) : '');
  return s;
}

const names = {
  project: (r) => (r.chance(0.5) ? syllables(r, 2) : r.pick(WORDS) + r.pick(TECH_SUFFIX)).toLowerCase(),
  product: (r) => cap(r.chance(0.5) ? syllables(r, 2) : r.pick(WORDS) + r.pick(['ly', 'io', 'board', 'desk', 'note', 'cast', 'mint', 'loop'])),
  company: (r) => `${cap(r.chance(0.5) ? syllables(r, 2) : r.pick(WORDS))} ${r.pick(BIZ_SUFFIX)}`,
  venue: (r) => `The ${cap(r.pick(WORDS))} ${r.pick(['Taproom', 'Commons', 'Library Annex', 'Coworking', 'Hall', 'Cafe', 'Brewing'])}`,
  newsletter: (r, topic) => `${cap(r.pick(WORDS))} ${r.pick(['Weekly', 'Digest', 'Notes', 'Dispatch', 'Bulletin'])}${topic ? ` (${topic})` : ''}`,
  version: (r) => `${r.int(1, 5)}.${r.int(0, 12)}${r.chance(0.3) ? `.${r.int(0, 9)}` : ''}`,
  handle(r, fullName, network) {
    const [first, ...rest] = fullName.toLowerCase().replace(/[^a-z ]/g, '').split(' ');
    const last = rest[rest.length - 1] || 'x';
    const n = r.chance(0.5) ? String(r.int(1, 99)) : '';
    const forms = network === 'devblog' || network === 'makers'
      ? [`${first}${last}`, `${first}_${last}`, `${first[0]}${last}`, `${first}${n}`, `${first}codes`, `${first}builds`]
      : [`${first}_${last}${n}`, `${first[0]}${last}${n}`, `${r.pick(WORDS)}_${first}`, `${first}${r.pick(WORDS)}${n}`, `${last}${first[0]}${n}`];
    return r.pick(forms).slice(0, 20);
  },
};

module.exports = { names, cap, WORDS };
