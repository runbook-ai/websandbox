'use strict';
// Parse a rendered item and check it against its spec. Returns { ok, title, body, problems[] }.
const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');
const AI_TELLS = [/\bas an ai\b/i, /\blanguage model\b/i, /\bdelve\b/i, /\bgame[- ]changer\b/i, /in today's fast-paced/i, /\btapestry\b/i, /\bI hope this (email|message) finds you well\b/i, /\bunlock the (power|potential)\b/i];
const PII = [/https?:\/\//i, /\bwww\./i, /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/, /\b\d{1,5} [A-Z][a-z]+ (?:St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Ln|Dr|Drive|Court|Ct)\b/];
const words = (s) => (s.match(/\S+/g) || []).length;

function parse(spec, text) {
  let t = text.replace(/^```(?:\w+)?\n([\s\S]*?)\n```$/m, '$1').trim();
  let title = null;
  const m = t.match(/^(TITLE|SUBJECT):\s*(.+)\n+/i);
  if (m) { title = m[2].trim().replace(/^["*]+|["*]+$/g, ''); t = t.slice(m[0].length).trim(); }
  t = t.replace(/^BODY:\s*/i, '');
  // a reply in a private conversation keeps the conversation's subject: drop a repeated "Re:" line
  if (spec.kind === 'dm' && !(spec.seq === 0 && spec.subject)) {
    if (title) title = null;
    t = t.replace(/^Re:[^\n]*\n+/i, '').trim();
  }
  return { title, body: t };
}

function validate(spec, text) {
  const problems = [];
  const { title, body } = parse(spec, text || '');
  const needsTitle = ['post', 'article'].includes(spec.kind) || spec.net === 'mail' || (spec.kind === 'dm' && spec.seq === 0 && !!spec.subject);
  if (!body) problems.push('empty');
  if (needsTitle && !title) problems.push('no-title');
  if (!needsTitle && spec.kind !== 'dm' && /^(TITLE|SUBJECT):/im.test(text || '')) problems.push('unexpected-title');
  if (spec.kind === 'dm' && /^(TITLE|SUBJECT):/im.test(body)) problems.push('unexpected-title');
  if (spec.net === 'micro') {
    if (body.length > 280) problems.push(`too-long:${body.length}c`);
  } else if (body) {
    const n = words(body), want = spec.words;
    if (n < want * 0.4 - 3) problems.push(`too-short:${n}/${want}w`);
    if (n > want * 2 + 20) problems.push(`too-long:${n}/${want}w`);
  }
  const all = norm(`${title || ''}\n${body}`);
  const missing = (spec.facts || []).filter((f) => !all.includes(norm(f)));
  if (missing.length) problems.push(`missing-facts:${missing.length}`);
  // private messages: no contact details or links (synthetic text only; any domain must be .example)
  if (spec.kind === 'dm' && (PII.some((re) => re.test(`${title || ''}\n${body}`)) || /@[a-z0-9-]+\.(?!example\b)[a-z]{2,}/i.test(body))) problems.push('contact-details');
  const tells = AI_TELLS.filter((re) => re.test(`${title || ''}\n${body}`)).map((re) => re.source);
  if (tells.length) problems.push(`ai-tell:${tells.length}`);
  return { ok: problems.length === 0, title, body, problems, factsHit: (spec.facts || []).length - missing.length, factsTotal: (spec.facts || []).length,
    emDashes: (body.match(/—/g) || []).length, words: words(body), chars: body.length };
}

module.exports = { validate, parse, AI_TELLS };
