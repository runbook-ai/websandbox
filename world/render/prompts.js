'use strict';
// Item spec + context -> chat messages. Output format is plain text with a TITLE:/SUBJECT: line when the
// kind has one, so long bodies don't need JSON escaping. PROMPT_VERSION is part of the cache key.
const PROMPT_VERSION = 'p2';

const NETWORK_RULES = {
  community: 'Reddit-style forum. Plain text or light markdown. No hashtags. Titles are short and specific, like real forum titles. Comments respond to what was actually said above them.',
  devblog: 'Developer blog community. Articles are markdown: a short intro, ## headings, and fenced code blocks where code is natural. Comments are conversational and refer to the article.',
  makers: 'Indie-founder community. First person, candid, concrete numbers and specifics, no hype. Comments are peer advice or questions.',
  micro: 'Microblog. At most 280 characters including spaces. No title. Hashtags rare (at most one, and only if natural). Replies are short and reactive.',
  mail: 'Email. First line "SUBJECT: ...", then a blank line, then the body with a greeting and sign-off that fit the relationship. Newsletters read like a real newsletter issue.',
};

const INTENT_HINT = {
  question: 'asks for help or opinions with a specific situation', experience: 'shares something that happened to them', advice: 'gives advice from their own experience',
  showcase: 'shows something they made', discussion: 'starts a discussion with a take', rant: 'vents about a frustration', news: 'shares news and their reaction',
  answer: 'answers or helps with the question/problem above', agree: 'agrees and adds a little', disagree: 'politely (or bluntly, if in character) disagrees and says why',
  joke: 'a short joke or quip about the thread', 'followup-question': 'asks a follow-up question', 'personal-anecdote': 'relates a brief story of their own',
  correction: 'corrects a factual point above', tutorial: 'a how-to with steps', opinion: 'an opinion piece', postmortem: 'what went wrong on a project and what they learned',
  listicle: 'a numbered list article', intro: 'introduces themselves to the community', til: 'a short "today I learned" article', thanks: 'thanks the author and mentions what helped',
  addition: 'adds a tip or caveat to the article', milestone: 'shares a milestone of their product', launch: 'announces they launched their product',
  'ask-feedback': 'asks for feedback on their product or plan', 'lesson-learned': 'shares a lesson learned building their business', 'revenue-update': 'shares revenue numbers and context',
  congrats: 'congratulates and adds something useful', thought: 'a passing thought', 'news-react': 'reacts to news', promo: 'mentions their own project, lightly', update: 'a small personal update',
  announce: 'announces an upcoming event they organise, with the practical details',
  'colleague-request': 'asks a colleague for something work-related', 'colleague-update': 'updates a colleague on work', 'friend-plan': 'makes plans with a friend',
  'family-news': 'shares family news', newsletter: 'a newsletter issue about the topic', 'vendor-quote': 'a vendor sending a quote for work or products', 'intro-request': 'asks for an introduction to someone', reply: 'replies to the previous email in the thread',
};

function styleText(st) {
  const bits = [`${st.formality} register`, `${st.verbosity} writer`, st.emoji === 'never' ? 'never uses emoji' : st.emoji === 'often' ? 'uses emoji often' : 'emoji rarely',
    st.lowercase ? 'types mostly in lowercase' : null, st.typos === 'some' ? 'leaves an occasional typo' : null, st.humor !== 'none' ? `${st.humor} humor` : null, ...(st.tics || [])];
  return bits.filter(Boolean).join('; ');
}

function personaText(p, net) {
  const handle = p.accounts?.[net]?.handle;
  return [`${p.name}${handle ? ` (handle @${handle})` : ''}, ${p.age}, ${p.city}, ${p.state}. Occupation: ${p.occupation.replace(/_/g, ' ')}.`,
    p.bio.persona, `Hobbies: ${p.bio.hobbies.join(', ')}.`, `Writing style: ${styleText(p.style)}.`].join('\n');
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + ' [...]' : s || '');

// ctx: { persona, parents: [{who, title, text}] (root first), from, to, relation, eventText, spaceLabel }
function buildMessages(spec, ctx) {
  const titled = ['post', 'article'].includes(spec.kind);
  const lines = [];
  lines.push(`Network: ${NETWORK_RULES[spec.net]}`);
  if (spec.net === 'mail') {
    lines.push(`From: ${ctx.from}`, `To: ${ctx.to}`, ctx.relation ? `Relationship: ${ctx.relation}` : null);
    if (ctx.writer) lines.push(`\nThe sender:\n${ctx.writer}`);
  } else {
    lines.push(`\nYou are writing as:\n${personaText(ctx.persona, spec.net)}`);
    if (spec.context) lines.push(`They ${spec.context}.`);
  }
  if (spec.space) lines.push(`Posting in: ${spec.net === 'community' ? `the "${spec.space}" community` : `the "${spec.space}" group`}`);
  if (spec.tags) lines.push(`Tags: ${spec.tags.map((t) => `#${t}`).join(' ')}`);
  lines.push(`Topic area: ${ctx.topicLabel || spec.topic}`);
  lines.push(`What this ${spec.kind} does: ${INTENT_HINT[spec.intent] || spec.intent}.`);
  if (ctx.eventText) lines.push(`Context: ${ctx.eventText}`);
  else if (['news', 'news-react'].includes(spec.intent)) lines.push('Context: something they read or noticed in everyday life or their local area (no invented news about real public figures or companies).');
  if (ctx.parents?.length) {
    lines.push('\nThread so far (oldest first):');
    for (const pa of ctx.parents) lines.push(`--- ${pa.who}${pa.title ? ` -- "${pa.title}"` : ''}\n${clip(pa.text, 1500)}`);
    lines.push('--- (your reply goes here)');
  }
  if (spec.facts?.length) lines.push(`\nMust include, verbatim: ${spec.facts.map((f) => `"${f}"`).join('; ')}.`);
  lines.push(spec.net === 'micro' ? 'Length: at most 280 characters.' : `Length: about ${spec.words} words.`);
  const format = spec.net === 'mail' ? 'SUBJECT: <subject>\n\n<body>' : titled ? 'TITLE: <title>\n\n<body>' : '<text only>';
  const system = [
    'You write one realistic piece of user-generated content for a synthetic website dataset. Write it exactly as this person would, in character, as if posting for real.',
    'Rules: no preamble or explanation; output only the content in the given format. Never mention AI, prompts or datasets.',
    'Avoid generic AI phrasing (no "delve", "game-changer", "in today\'s fast-paced world", "I hope this finds you well" unless the persona would truly write it). Prefer plain words. Use em dashes sparingly or not at all.',
    'Only name people who are given here; invent nothing about real private individuals. Public places, sports teams, artists and common products may be mentioned naturally, but never invent news, releases, scandals or quotes about real public people, bands or companies.',
    `Format:\n${format}`,
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: lines.filter((l) => l != null).join('\n') }];
}

module.exports = { buildMessages, PROMPT_VERSION, styleText, personaText };
