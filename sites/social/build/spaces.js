'use strict';
// Space metadata for the social migration: names of new spaces, titles, about texts, rules (with
// gradable kinds), flair sets and posting limits. Pure functions of (name, seeded rng).

// World spaces whose name is already a WebArena forum get a new space of their own: the converted
// forum tasks read those forums ("the newest post in books", "the latest post on DIY"), so world
// posts must not land in them.
const ALIAS = {
  books: 'bookclub', movies: 'filmbuffs', television: 'tvtalk', music: 'musiclovers', sports: 'sportsfans', diy: 'diyprojects',
  personalfinance: 'moneymatters', earthporn: 'landscapephotos', gaming: 'videogames', dataisbeautiful: 'dataviz', jerseycity: 'jerseycitylocal',
};
function alias(space, existing) {
  let name = ALIAS[space.toLowerCase()] || space;
  for (let k = 2; existing.has(name.toLowerCase()); k++) name = `${ALIAS[space.toLowerCase()] || space}${k === 2 ? 'talk' : k}`;
  return name;
}

const TITLES = {
  bookclub: 'Book Club', filmbuffs: 'Film Buffs', tvtalk: 'TV Talk', musiclovers: 'Music Lovers', sportsfans: 'Sports Fans', diyprojects: 'DIY Projects',
  moneymatters: 'Money Matters', landscapephotos: 'Landscape Photos', videogames: 'Video Games', dataviz: 'Data Viz', jerseycitylocal: 'Jersey City Local',
  cscareerquestions: 'CS Career Questions', learnprogramming: 'Learn Programming', suggestmeabook: 'Suggest Me a Book', getdisciplined: 'Get Disciplined',
  vegetablegardening: 'Vegetable Gardening', fantasyfootball: 'Fantasy Football', boardgames: 'Board Games', selfhosted: 'Self-Hosted',
  smallbusiness: 'Small Business', sidehustle: 'Side Hustle', homebrewing: 'Homebrewing', daddit: 'Dads', webdev: 'Web Dev', sysadmin: 'Sysadmin',
  TalesFromRetail: 'Tales From Retail', KitchenConfidential: 'Kitchen Confidential', HomeImprovement: 'Home Improvement',
};
const title = (name) => TITLES[name] || name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

const ABOUT = [
  (n, l) => `A place to talk about ${l}. Questions, projects, wins and fails all welcome.`,
  (n, l) => `Everything ${l}: share what you are working on, ask for advice and help others out.`,
  (n, l) => `${title(n)} is a community for people into ${l}. Beginners and old hands alike.`,
  (n, l) => `Discussion, questions and stories about ${l}. Read the rules before you post.`,
];
const about = (name, label, r) => r.pick(ABOUT)(name, label);

const TEXT_RULES = [
  ['Be civil', 'Treat others with respect. No personal attacks, harassment, slurs or bigotry.'],
  ['Stay on topic', 'Posts must be about the subject of this community. Off-topic posts are removed.'],
  ['No spam', 'No repeated posts, vote manipulation, bots or chain posts.'],
  ['Search before posting', 'Check whether your question was answered recently before asking it again.'],
  ['No low-effort posts', 'One-word posts, memes without context and "title says it all" posts are removed.'],
  ['No personal information', 'Do not post anyone\'s full name, address, phone number or other private details.'],
  ['Be helpful', 'Answer the question that was asked. "Just google it" replies are removed.'],
];
const TITLE_FORMATS = [
  { title: 'Tag your title', description: 'Start the title with a tag in square brackets: [Question], [Help], [Discussion], [Story], [Advice], [Showcase] or [News].',
    param: { pattern: '^\\[(Question|Help|Discussion|Story|Advice|Showcase|News)\\] ', example: '[Question] How do I get started?' } },
  { title: 'Descriptive titles only', description: 'Titles must be at least 25 characters and say what the post is about.', param: { pattern: '^.{25,}$', example: 'Looking for advice on my first sourdough starter' } },
  { title: 'Questions end with a question mark', description: 'Titles must be phrased as a question and end with "?".', param: { pattern: '\\?\\s*$', example: 'What should I read after Dune?' } },
];

// rules(forum, rng, {isNew, topic}) -> [{title, description, kind, param}] in display order.
function rules(f, r, { isNew }) {
  const n = f.normalized_name;
  const out = [];
  const text = r.sample(TEXT_RULES, r.int(2, 4)).sort((x, y) => TEXT_RULES.indexOf(x) - TEXT_RULES.indexOf(y));
  out.push(...text.map(([t, d]) => ({ title: t, description: d, kind: 'text' })));
  const images = /pics|porn|photo|art|aww|gifs|memes|photoshop|landscape|oldschoolcool/.test(n);
  if (r.chance(isNew ? 0.55 : 0.4)) out.push({ title: 'No self-promotion', description: 'Do not post links to, or ads for, your own product, business, project, channel or employer. Promotional posts are removed.', kind: 'no-self-promo' });
  if (r.chance(isNew ? 0.4 : 0.25)) out.push({ title: 'Flair your post', description: 'Every post needs a flair. Pick the one that fits best when you submit.', kind: 'flair-required' });
  if (!images && r.chance(0.22)) out.push({ title: 'Text posts only', description: 'No link posts and no URLs in posts. Describe things in your own words.', kind: 'no-links' });
  if (r.chance(0.25)) { const d = r.pick([7, 14, 30, 90]); out.push({ title: `Accounts must be ${d} days old`, description: `New accounts cannot post here. Your account must be at least ${d} days old.`, kind: 'min-account-age', param: d }); }
  if (r.chance(0.18)) { const k = r.pick([10, 25, 50, 100]); out.push({ title: `Minimum ${k} karma to post`, description: `You need at least ${k} karma (post plus comment karma) to post here.`, kind: 'min-karma', param: k }); }
  let tf = null;
  if (n === 'explainlikeimfive') tf = { title: 'Start your title with ELI5:', description: 'Every title starts with "ELI5:" followed by the question.', param: { pattern: '^ELI5: ', example: 'ELI5: Why is the sky blue?' } };
  else if (/^ask/.test(n)) tf = TITLE_FORMATS[2];
  else if (r.chance(0.16)) tf = r.pick(TITLE_FORMATS);
  if (tf) out.push({ ...tf, kind: 'title-format', param: JSON.stringify(tf.param) });
  return out;
}

const FLAIR_BY_INTENT = { question: 'Question', experience: 'Story', advice: 'Advice', showcase: 'Showcase', discussion: 'Discussion', rant: 'Rant', news: 'News' };
const FLAIR_COLORS = { Question: '#0079d3', Discussion: '#46d160', Advice: '#ffb000', Showcase: '#ff66ac', Story: '#7193ff', Rant: '#ea0027', News: '#00a6a5', Meta: '#646d73', 'Mod Post': '#1a1a1b', Help: '#ff8717', Humor: '#94e044' };
function flairs(f, r) {
  const pool = ['Advice', 'Showcase', 'Story', 'Rant', 'News', 'Help', 'Humor', 'Meta'];
  const names = ['Question', 'Discussion', ...r.sample(pool, r.int(2, 5))];
  const out = names.map((name) => ({ name, color: FLAIR_COLORS[name], mod_only: 0 }));
  if (r.chance(0.5)) out.push({ name: 'Mod Post', color: FLAIR_COLORS['Mod Post'], mod_only: 1 });
  return out;
}

// Network-wide posting limits ("you're posting too fast"). Per-forum ones are drawn per forum.
const LIMITS = {
  community: [
    { action: 'comment', max: 6, window: 600, message: "You're doing that too much. You can comment at most 6 times in 10 minutes." },
    { action: 'submission', max: 3, window: 3600, message: "You're posting too fast. You can create at most 3 posts per hour." },
    { action: 'submission', max: 1, window: 86400, ageBelow: 7, message: 'New accounts (under 7 days old) can create one post per day.' },
    { action: 'comment', max: 10, window: 86400, ageBelow: 2, message: 'New accounts (under 2 days old) can comment at most 10 times a day.' },
  ],
  devblog: [{ action: 'submission', max: 5, window: 86400, message: 'You can publish at most 5 articles per day.' }, { action: 'comment', max: 10, window: 600, message: 'Slow down: at most 10 comments in 10 minutes.' }],
  makers: [{ action: 'submission', max: 2, window: 86400, message: 'You can post at most twice a day.' }, { action: 'comment', max: 10, window: 600, message: 'Slow down: at most 10 comments in 10 minutes.' }],
  micro: [{ action: 'submission', max: 50, window: 3600, message: 'You are over the hourly posting limit (50 posts).' }, { action: 'comment', max: 50, window: 3600, message: 'You are over the hourly reply limit (50 replies).' }],
};

module.exports = { ALIAS, alias, title, about, rules, flairs, FLAIR_BY_INTENT, FLAIR_COLORS, LIMITS };
