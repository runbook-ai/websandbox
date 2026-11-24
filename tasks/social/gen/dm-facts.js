'use strict';
// Direct-message facts (world_dm_threads.facts, world/sim/dms.js) as answer references and state
// checks, shared by the community (tasks/social/gen/dm.js) and micro (tasks/net/gen/micro.js) DM
// templates. Facts are written verbatim into the first message; answers may word them differently
// ("6:30pm" / "6:30 pm"), so a fact becomes one or more must_include items with |OR| alternatives.
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// "10am" -> 10am |OR| 10 am |OR| 10:00 am |OR| 10:00am |OR| 10 a.m.
function timeAlts(t) {
  if (t === 'noon') return ['noon', '12pm', '12 pm', '12:00'];
  const m = /^(\d{1,2})(?::(\d\d))?(am|pm)$/.exec(t);
  if (!m) return [t];
  const [, h, mm, ap] = m;
  const hm = `${h}:${mm || '00'}`;
  return [...new Set([`${h}${mm ? `:${mm}` : ''}${ap}`, `${h}${mm ? `:${mm}` : ''} ${ap}`, `${hm} ${ap}`, `${hm}${ap}`, `${h}${mm ? `:${mm}` : ''} ${ap[0]}.m.`])];
}
const or = (xs) => xs.join(' |OR| ');
// a venue answer may drop the leading "The"
const venueCore = (v) => v.replace(/^The /, '');

// meet-up facts ["Saturday at 10am", "The Lantern Brewing"] -> must_include items
function meetRefs([when, where]) {
  const [day, , time] = when.split(' ');
  return [day, or(timeAlts(time)), venueCore(where)];
}
// work-ask deadline -> must_include items
function deadlineRefs(d) {
  const m = /^(\w+day) (\S+)$/.exec(d);
  if (m) return [m[1], or(timeAlts(m[2]))];                                    // Thursday 2pm
  if (/^\w+day at noon$/.test(d)) return [d.split(' ')[0], or(timeAlts('noon'))]; // Tuesday at noon
  if (/^end of day /.test(d)) return [d.split(' ').pop()];                        // end of day Friday
  if (/^next /.test(d)) return [d.split(' ').pop()];                             // next Wednesday
  if (/ morning$/.test(d)) return [d.split(' ')[0], 'morning'];                  // Monday morning
  return [d];
}
// SQL condition: a column mentions every must_include item (any alternative), case-insensitive
function mentionsSql(col, refs, lit) {
  return refs.map((r) => `(${r.split(' |OR| ').map((alt) => `instr(lower(${col}), lower(${lit(alt)})) > 0`).join(' OR ')})`).join(' AND ');
}
// later messages that name another day or time make "when" ambiguous
function otherWhen(text, day, time) {
  if (DAYS.some((d) => d !== day && new RegExp(`\\b${d}\\b`, 'i').test(text)) || /\b(tomorrow|tonight|next week)\b/i.test(text)) return true;
  const want = (time || '').replace(/:00/, '').replace(/\s|\./g, '').toLowerCase();
  for (const m of text.matchAll(/\b(\d{1,2}(?::\d\d)?)\s?(am|pm|a\.m\.|p\.m\.)/gi)) if (`${m[1].replace(/:00/, '')}${m[2].replace(/\./g, '')}`.toLowerCase() !== want) return true;
  return /\bnoon\b/i.test(text) && time !== 'noon';
}

module.exports = { DAYS, timeAlts, meetRefs, deadlineRefs, mentionsSql, otherWhen, venueCore };
