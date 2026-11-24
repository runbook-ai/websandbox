'use strict';
// Pure helpers: search, web (pagination/sort/filter/validate), auth, grader.
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const kit = require('..');
const { search, grader } = kit;

const fakeReq = (url) => {
  const u = new URL(url, 'http://x');
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
  return { url: u.pathname + u.search, query };
};

test('search.match sanitises user input into a safe FTS5 expression', () => {
  assert.equal(search.match('quick brown'), '"quick" AND "brown"*');
  assert.equal(search.match('quick brown', { prefix: 'none' }), '"quick" AND "brown"');
  assert.equal(search.match('"brown fox" jumps'), '"brown fox" AND "jumps"*');
  assert.equal(search.match('a" OR b* NEAR(c) -d ^e:f'), '"a" AND "or" AND "b" AND "near" AND "c" AND "d" AND "e" AND "f"*');
  assert.equal(search.match('garden bike', { synonyms: { bike: ['bicycle'] } }), '"garden" AND ("bike"* OR "bicycle")');
  assert.equal(search.match('!!! ***'), null);
  assert.equal(search.match('bike', { synonyms: { bike: ['bicycle'] } }), '("bike"* OR "bicycle")');
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(title, body); INSERT INTO t VALUES ('Quick brown fox', 'jumps over the lazy dog'), ('Lazy afternoon', 'a quick nap'), ('bicycle repair', 'fix a flat');");
  db.exec("CREATE TABLE syn(term, synonym); INSERT INTO syn VALUES ('bike', 'bicycle')");
  // every sanitised string must be valid FTS5 syntax
  for (const s of ['a" OR', 'NOT', 'AND OR NOT', '(((', 'x*y', 'col:term', '"unbalanced', "it's", 'ünïcödé straße', '日本語']) {
    const m = search.match(s);
    if (m) db.prepare('SELECT count(*) FROM t WHERE t MATCH ?').get(m);
  }
  const s = search.prepare(db, 't', 'quick', { weights: { title: 10, body: 1 } });
  assert.equal(s.rank, 'bm25(t, 10.00, 1.00)');
  const rows = db.prepare(`SELECT title, ${s.highlight('title')} AS h, ${s.snippet('body', 5)} AS sn FROM t WHERE t MATCH ? ORDER BY ${s.rank}`).all(s.match);
  assert.equal(rows[0].title, 'Quick brown fox'); // title weight wins
  assert.equal(search.markup(rows[0].h), '<mark>Quick</mark> brown fox');
  assert.equal(search.markup('<b>\u0002x\u0003'), '&lt;b&gt;<mark>x</mark>');
  const syn = search.prepare(db, 't', 'bike', { synonyms: 'syn' });
  assert.equal(db.prepare('SELECT title FROM t WHERE t MATCH ?').pluck().get(syn.match), 'bicycle repair');
  assert.equal(db.prepare('SELECT title FROM t WHERE t MATCH ?').pluck().get(search.match('flat bike', { db, synonyms: 'syn' })), 'bicycle repair');
  assert.equal(search.didYouMean(db, 't', 'quikc borwn'), 'quick brown');
  assert.equal(search.didYouMean(db, 't', 'lazy'), null);
  assert.equal(search.didYouMean(db, 't', 'bicycel'), 'bicycle');
  assert.equal(search.editDistance('kitten', 'sitting'), 3);
  assert.equal(search.editDistance('ab', 'ba'), 1);
});

test('paginate / sorter / filters / urlWith use stable params', () => {
  const req = fakeReq('/list?q=x&page=3&sort=price_desc&brand=Acme&price_min=10&bad=');
  const p = kit.paginate(req, 95, { perPage: 10 });
  assert.equal(p.page, 3); assert.equal(p.pages, 10); assert.equal(p.offset, 20);
  assert.equal(p.prev, '/list?q=x&page=2&sort=price_desc&brand=Acme&price_min=10');
  assert.equal(p.links[0].href, '/list?q=x&sort=price_desc&brand=Acme&price_min=10');
  assert.deepEqual(p.links.map((l) => l.gap ? '…' : l.n), [1, 2, 3, 4, 5, '…', 10]);
  assert.equal(kit.paginate(fakeReq('/l?page=99'), 5).page, 1);
  const s = kit.sorter(req, { options: { price: 'p.price', name: 'p.name' }, default: 'name_asc', tiebreak: 'p.id' });
  assert.equal(s.orderBy, 'p.price DESC, p.id DESC');
  assert.equal(s.link('price'), '/list?q=x&sort=price_asc&brand=Acme&price_min=10');
  assert.equal(kit.sorter(fakeReq('/l?sort=evil;drop_asc'), { options: { name: 'n' }, default: 'name_desc' }).orderBy, 'n DESC');
  const f = kit.filters(req, { brand: { col: 'p.brand' }, price_min: { col: 'p.price', op: '>=', type: 'number' }, bad: { col: 'x' }, tags: { col: 't', op: 'in' } });
  assert.equal(f.where, 'p.brand = ? AND p.price >= ?');
  assert.deepEqual(f.params, ['Acme', 10]);
  assert.equal(f.active[0].removeHref, '/list?q=x&sort=price_desc&price_min=10');
  const g = kit.filters(fakeReq('/l?tags=a,b&name=50%_off'), { tags: { col: 't', op: 'in' }, name: { col: 'n', op: 'like' } });
  assert.equal(g.where, "t IN (?,?) AND n LIKE ? ESCAPE '\\'");
  assert.deepEqual(g.params, ['a', 'b', '%50\\%\\_off%']);
});

test('validate', () => {
  const v = kit.validate({ title: '  hi ', price: 'abc', qty: '3', email: 'no', agree: 'on', color: 'red' }, {
    title: { required: true, minLength: 3 }, price: { type: 'number' }, qty: { type: 'int', max: 2 }, email: { type: 'email' },
    agree: { type: 'bool' }, color: { oneOf: ['blue'] }, missing: { required: true, label: 'Name' }, opt: { default: 'x' },
  });
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, {
    title: 'Title must be at least 3 characters.', price: 'Price must be a number.', qty: 'Qty must be at most 2.',
    email: 'Email must be a valid email address.', color: 'Color has an invalid value.', missing: 'Name is required.',
  });
  assert.equal(v.values.agree, true); assert.equal(v.values.opt, 'x'); assert.equal(v.values.qty, 3);
  assert.equal(kit.validate({ a: '5' }, { a: { type: 'int', min: 1 } }).ok, true);
});

test('auth: scrypt, bcrypt, argon2, plain', async () => {
  const h = kit.auth.hashPassword('s3cret');
  assert.ok(await kit.auth.verifyPassword('s3cret', h));
  assert.ok(!(await kit.auth.verifyPassword('nope', h)));
  const { bcrypt, argon2id } = require('hash-wasm');
  const salt = new Uint8Array(16).fill(7);
  const b = await bcrypt({ password: 'pw', salt, costFactor: 4, outputType: 'encoded' });
  assert.ok(await kit.auth.verifyPassword('pw', b.replace('$2b$', '$2y$')));
  const a = await argon2id({ password: 'pw', salt, parallelism: 1, iterations: 2, memorySize: 512, hashLength: 32, outputType: 'encoded' });
  assert.ok(await kit.auth.verifyPassword('pw', a));
  assert.ok(await kit.auth.verifyPassword('pw', 'plain$pw'));
  assert.ok(!(await kit.auth.verifyPassword('pw', 'md5$whatever')));
});

test('grader: answers, URLs, state', async () => {
  assert.ok(grader.exactMatch(' "Yes" ', 'yes'));
  assert.ok(grader.mustInclude('The total is $55.00 for 2 items', ['55.00', '2 |OR| two']));
  assert.ok(grader.mustInclude('total 55', ['55.00'])); // numbers compare by value
  assert.ok(grader.mustInclude('order 000001170', ['1170']));
  assert.ok(grader.exactMatch('Stephane Peters', 'Stéphane Peters'));
  assert.ok(!grader.mustInclude('10 comments', ['1']));
  assert.ok(!grader.mustInclude('$2.15', ['1']));
  assert.ok(!grader.mustInclude('total 55.5', ['55']));
  // phone-like references compare by digits (country code optional)
  assert.ok(grader.mustInclude('412-111-1111', ['4121111111']));
  assert.ok(grader.mustInclude('Phone: (412) 111 1111.', ['4121111111']));
  assert.ok(grader.mustInclude('+1 412.111.1111', ['4121111111']));
  assert.ok(grader.mustInclude('call 4121111111', ['+1 (412) 111-1111']));
  assert.ok(!grader.mustInclude('412-111-1112', ['4121111111']));
  assert.ok(!grader.mustInclude('412 111', ['4121111111']));
  // quote marks and backslashes are dropped on both sides
  const titles = ["Topiary Trees (2 Pack, 4' Cypress)", 'Russound 5B45W 4" Indoor Outdoor Speakers'];
  assert.ok(grader.mustInclude('Topiary Trees (2 Pack, 4\\\' Cypress), Russound 5B45W 4\\" Indoor Outdoor Speakers', titles));
  assert.ok(grader.mustInclude('Topiary Trees (2 Pack, 4 Cypress); Russound 5B45W 4 Indoor Outdoor Speakers', titles));
  assert.ok(grader.mustInclude('Topiary Trees (2 Pack, 4’ Cypress), Russound 5B45W 4” Indoor  Outdoor Speakers', titles));
  assert.ok(!grader.mustInclude('Topiary Trees (2 Pack, 5 Cypress), Russound 5B45W 4 Indoor Outdoor Speakers', titles));
  assert.ok(grader.exactMatch("Men's", 'mens'));
  assert.ok(grader.urlMatch('http://127.10.3.2/search?sort=price_desc&q=usb+hub&page=1', '__SHOPPING__/search?q=usb%20hub&sort=price_desc'));
  assert.ok(!grader.urlMatch('http://x/search?q=usb', '__SHOPPING__/search?q=usb&sort=price_desc'));
  assert.ok(!grader.urlMatch('http://x/search?q=usb&sort=price_desc&page=2', '__SHOPPING__/search?q=usb&sort=price_desc', { mode: 'exact' }));
  assert.ok(grader.urlMatch('http://x/f/books/', '__REDDIT__/f/books'));
  assert.ok(grader.urlMatch('http://x/f/books/12/a-title', '__REDDIT__/f/books', { mode: 'prefix' }));
  assert.ok(!grader.urlMatch('http://x/f/bookshelf', '__REDDIT__/f/books', { mode: 'prefix' }));
  assert.ok(!grader.urlMatch('http://x/f/books/12/a-title', '__REDDIT__/f/books'));
  assert.ok(grader.stateMatch([{ n: '55.00' }], 55));
  assert.ok(grader.stateMatch([{ a: 1, b: 'x' }, { a: 2, b: 'y' }], [[2, 'y'], [1, 'x']]));
  assert.ok(!grader.stateMatch([{ a: 1 }, { a: 2 }], { rows: [[2], [1]], ordered: true }));
  assert.ok(grader.stateMatch([{ a: 1, b: 2 }], [{ b: 2 }]));
  assert.ok(grader.stateMatch([], { count: 0 }));
  assert.ok(grader.stateMatch([{ x: 1 }], { nonempty: true }));
  assert.ok(grader.stateMatch([{ x: 3 }], { min: 2, max: 3 }));
  assert.ok(grader.stateMatch([{ x: 1 }, { x: 2 }], { includes: [2] }));
  const db = new Database(':memory:');
  db.exec("CREATE TABLE p(name, price); INSERT INTO p VALUES ('Circe fleece', 55), ('Antonia tank', 34)");
  const query = async (sql) => db.prepare(sql).all();
  let r = await grader.grade({ eval: { type: 'answer', answer: { exact: '$sql' }, answer_sql: "SELECT price FROM p WHERE name = 'Circe fleece'" } }, { answer: '55', query });
  assert.equal(r.pass, true);
  r = await grader.grade({ eval: { type: ['answer', 'url'], answer: { must_include: ['Circe', 'Antonia'] }, answer_sql: 'SELECT name FROM p', url: '__SHOPPING__/p?sort=price_asc' } },
    { answer: 'circe fleece and antonia tank', url: 'http://h/p?sort=price_asc&page=1', query });
  assert.equal(r.pass, true);
  assert.equal(r.checks[0].drift, true); // static refs differ from the SQL values
  r = await grader.grade({ eval: { type: 'state', state_sql: ['SELECT price FROM p WHERE name = \'Circe fleece\'', 'SELECT count(*) FROM p'], state_expect: [55, 3] } }, { query });
  assert.equal(r.pass, false); assert.equal(r.checks[0].pass, true); assert.equal(r.checks[1].pass, false);
  r = await grader.grade({ intent: 'q', eval: { type: 'answer', answer: { fuzzy: ['about 55 dollars'] } } }, { answer: '55' });
  assert.equal(r.pass, null); assert.equal(r.checks[0].pending, 'fuzzy');
  r = await grader.grade({ intent: 'q', eval: { type: 'answer', answer: { fuzzy: ['55'] } } }, { answer: '55', fuzzy: async ({ answer, reference }) => answer === reference[0] });
  assert.equal(r.pass, true);
  r = await grader.grade({ eval: { type: 'state', state_sql: 'DELETE FROM p', state_expect: 1 } }, { query: async () => { throw new Error('read-only'); } });
  assert.equal(r.pass, false); assert.match(r.checks[0].error, /read-only/);
});

test('grader: cross-site state checks and answer_site', async () => {
  const shop = new Database(':memory:'); const forum = new Database(':memory:');
  shop.exec("CREATE TABLE reviews(title, rating); INSERT INTO reviews VALUES ('Broke fast', 1), ('Great', 5)");
  forum.exec("CREATE TABLE submissions(title, body); INSERT INTO submissions VALUES ('feedback', 'Broke fast')");
  const q = (db) => async (sql) => db.prepare(sql).all();
  const queries = { shopping: q(shop), forum: q(forum) };
  const task = { site: 'cross', grade_site: 'forum', sites: ['shopping', 'forum'], eval: {
    type: 'state',
    state: [
      { site: 'forum', sql: "SELECT count(*) FROM submissions WHERE body LIKE '%Broke fast%'", expect: 1 },
      { site: 'shopping', sql: 'SELECT count(*) FROM reviews WHERE rating <= 2', expect: 1 },
    ] } };
  let r = await grader.grade(task, { queries });
  assert.equal(r.pass, true); assert.deepEqual(r.checks.map((c) => c.site), ['forum', 'shopping']);
  // `query` stands for the grading site; a missing site's query function fails only its check
  r = await grader.grade(task, { query: q(forum) });
  assert.equal(r.pass, false); assert.equal(r.checks[0].pass, true); assert.match(r.checks[1].error, /site 'shopping'/);
  // state_sql (grading site) and state together; inferred type
  r = await grader.grade({ grade_site: 'forum', eval: { state_sql: 'SELECT count(*) FROM submissions', state_expect: 1,
    state: [{ site: 'shopping', sql: 'SELECT count(*) FROM reviews', expect: 2 }] } }, { queries });
  assert.equal(r.pass, true); assert.equal(r.checks.length, 2);
  r = await grader.grade({ grade_site: 'forum', eval: { answer: { exact: '$sql' }, answer_sql: "SELECT title FROM reviews WHERE rating = 1", answer_site: 'shopping' } },
    { answer: 'broke fast', queries });
  assert.equal(r.pass, true);
});

test('grader: numeric answers with units and tolerance', async () => {
  const n = (a, spec) => grader.numericMatch(a, spec);
  // durations: compound forms are summed, h:mm, plural/abbreviated units
  assert.ok(n('1h 22min', { value: 82, unit: 'min' }));
  assert.ok(n('It takes 1 hour and 22 minutes.', { value: 82, unit: 'min' }));
  assert.ok(n('about 82 mins', { value: 82, unit: 'min' }));
  assert.ok(n('Time: 1:22 (h:mm)', { value: 82, unit: 'min' }));
  assert.ok(n('5h 47min', { value: 346, unit: 'min', tol_abs: 2 }));
  assert.ok(!n('5h 49min', { value: 346, unit: 'min', tol_abs: 2 }));
  assert.ok(!n('1h 22min', { value: 22, unit: 'min' })); // the minutes part is not a quantity of its own
  assert.ok(n('walking 14 min, driving 2 min', [{ value: 2, unit: 'min' }, { value: 14, unit: 'min' }]));
  assert.ok(!n('walking 14 min, driving 3 min', [{ value: 2, unit: 'min' }, { value: 14, unit: 'min' }]));
  assert.ok(n('1.5 hours', { value: 90, unit: 'min' }));
  // distances: m vs km vs miles, thousands separators; spec unit 'm' = metres
  assert.ok(n('The walking distance is 0.78 km', { value: 780, unit: 'm' }));
  assert.ok(n('780 m', { value: 0.78, unit: 'km' }));
  assert.ok(n('1,200 meters', { value: 1.2, unit: 'km', tol_pct: 5 }));
  assert.ok(n('0.9 miles', { value: 1.45, unit: 'km' }));
  assert.ok(!n('1.7 km', { value: 1.4, unit: 'km' }));
  assert.ok(!n('22 min', { value: 22, unit: 'm' })); // minutes are not a distance
  // tolerance: default 10 %, tol_pct and tol_abs (spec unit), the larger wins
  assert.ok(n('16 min', { value: 15, unit: 'min' }) && !n('17 min', { value: 15, unit: 'min' }));
  assert.ok(n('3 min', { value: 2, unit: 'min', tol_abs: 1 }) && !n('3 min', { value: 2, unit: 'min' }));
  // bare numbers count only when no number carries a unit of that kind
  assert.ok(n('15', { value: 15, unit: 'min' }));
  assert.ok(!n('zip 15213, 20 min', { value: 15, unit: 'min' }));
  assert.throws(() => n('3 min', { value: 3, unit: 'parsecs' }), /unknown numeric unit/);
  // coordinates in decimal degrees, signs from N/S/E/W
  const ll = [{ value: 40.4424, unit: 'deg', tol_abs: 0.0015 }, { value: -79.9397, unit: 'deg', tol_abs: 0.0015 }];
  assert.ok(n('40.4424191, -79.9397388', ll));
  assert.ok(n('Latitude 40.442, longitude -79.939', ll));
  assert.ok(n('40.4424° N, 79.9397° W', ll));
  assert.ok(!n('40.4424, 79.9397', ll)); // east, not west
  assert.ok(!n('40.4524, -79.9397', ll));
  // in grade(): answer as a list of specs, one check each
  let r = await grader.grade({ eval: { type: 'answer', answer: [{ must_include: ['Hyatt Regency'] }, { numeric: { value: 15, unit: 'min', tol_abs: 1 } }] } },
    { answer: 'Hyatt Regency Pittsburgh International Airport; 16 min by car' });
  assert.equal(r.pass, true); assert.equal(r.checks.length, 2); assert.equal(r.checks[1].mode, 'numeric');
  r = await grader.grade({ eval: { answer: [{ must_include: ['Hyatt Regency'] }, { numeric: { value: 15, unit: 'min', tol_abs: 1 } }] } }, { answer: 'Hyatt Regency, 25 min' });
  assert.equal(r.pass, false); assert.equal(r.checks[0].pass, true); assert.equal(r.checks[1].pass, false);
  r = await grader.grade({ eval: { answer: { numeric: { value: 4.0, unit: 'km' } } } }, { answer: '' });
  assert.equal(r.pass, false);
});

test('grader: strict numbers for count/amount questions', async () => {
  const g = (intent, answer, answerSpec, extra = {}) => grader.grade({ intent, eval: { type: 'answer', answer: answerSpec, ...extra } }, { answer });
  const reviews = 'How many reviews did the Circe fleece get in 2022?';
  const three = { must_include: ['3'] };
  // gaming by listing numbers fails; the plain answer passes
  assert.equal((await g(reviews, '1, 2, 3, 4, 5', three)).pass, false);
  assert.deepEqual((await g(reviews, '1, 2, 3, 4, 5', three)).checks[0].extra_numbers, ['1', '2', '4', '5']);
  assert.equal((await g(reviews, 'Either 3 or 4', three)).pass, false);
  assert.equal((await g(reviews, 'There are 3 reviews', three)).pass, true);
  assert.equal((await g(reviews, 'three', { must_include: ['3 |OR| three'] })).pass, true);
  // numbers that the intent mentions are ignored (year, "top 5", month names in dates)
  assert.equal((await g(reviews, '3 reviews in 2022', three)).pass, true);
  assert.equal((await g('How many orders did I place in May 2023?', '3 orders (2023-05-01 to 2023-05-31)', three)).pass, false); // 31
  assert.equal((await g('How many orders did I place on May 1, 2023?', '3 orders on 2023-05-01', three)).pass, true);
  assert.equal((await g('How many of the top 5 posts are images?', '3 of the top 5', three)).pass, true);
  // values compare by value: "$45.00" is 45
  assert.equal((await g('How much did I spend on order 12?', 'I spent $45.00 on order 12', { must_include: ['45'] })).pass, true);
  // a legit extra number still fails a count question (intended: answer the count alone)
  let r = await g('How many orders did I place?', '3 orders, total $45', three);
  assert.equal(r.pass, false); assert.equal(r.checks[0].strict_numbers, true); assert.deepEqual(r.checks[0].extra_numbers, ['45']);
  // several numeric references are all allowed
  assert.equal((await g('How many open and closed issues?', '4 open, 7 closed', { must_include: ['4', '7'] })).pass, true);
  // not a count question, a text reference, or an explicit override: unchanged
  assert.equal((await g('What is the zip code of CMU?', '15213 (5000 Forbes Ave)', { must_include: ['15213'] })).pass, true);
  assert.equal((await g('How many stars and who wrote it?', 'Jane, 4 stars, 2 votes', { must_include: ['Jane', '4'] })).pass, true);
  assert.equal((await g('How many orders did I place?', '3 orders, total $45', { must_include: ['3'], strict_numbers: false })).pass, true);
  assert.equal((await g('Which order number is it?', '12 or 13', { must_include: ['12'], strict_numbers: true })).pass, false);
  assert.equal((await g('How many orders did I place?', '3 orders, total $45', three, { strict_numbers: false })).pass, true);
  // the trigger: identifiers and sort keys are not counts
  assert.equal((await g('What is the phone number of Western Pennsylvania Hospital', '+1 412 578 5000', { must_include: ['412', '578', '5000'] })).pass, true);
  assert.equal((await g('Which of her orders has the highest grand total? Give the order #.', 'Order #1036 ($245.10)', { must_include: ['1036'] })).pass, true);
  assert.equal((await g('Tell me the grand total of order 12', '$45 (2 items)', { must_include: ['45'] })).pass, false);
  // the trigger reads the asked part: a trailing scope sentence after the question is not the question
  const range = 'What is the price range for products from ugreen? Count every product whose brand or product name starts with "ugreen".';
  assert.equal((await g(range, 'from $6.99 to $38.99. There are 18 products', { must_include: ['6.99', '38.99'] })).pass, true);
  assert.equal(grader.askedPart(range), 'What is the price range for products from ugreen?');
  assert.equal(grader.askedPart('In the thread "Why?" (books forum), count the comments by X.'), 'In the thread "Why?" (books forum), count the comments by X.');
  assert.equal(grader.askedPart('How large is X? Give its total area in km².'), 'How large is X? Give its total area in km².');
  assert.equal((await g('Which forum is it? Count their posts per forum.', '3 or 4', three)).pass, true); // not a count question
  // an itemised breakdown after the answer number that adds up to it is not a list of candidates
  const units = 'Open order 000000164 in the admin and tell me its total number of units ordered.';
  const four = { must_include: ['4'] };
  assert.equal((await g(units, 'Order 000000164 has a total of 4 units ordered (1 Zoltan Gym Tee, 1 Layla Tee, 1 Chaz Kangeroo Hoodie, and 1 Argus All-Weather Tank).', four)).pass, true);
  assert.equal((await g('In the thread X, count the comments by Y.', "Y made 3 comments (2 on [deleted]'s comment, 1 on Z's reply)", three)).pass, true);
  for (const a of ['4 units (or 5)', '4 units (3 or 1)', '4 units (1, 2, 3, 4)', '4 units (2 tees, 3 hoodies)', '4 units (maybe 3 tees, 1 tank)',
    '4 units (3-4 tees)', '3 or 4 units (1 tee, 3 hoodies)', '4 units (1 unit each of A, B, C, D)', '4 (1 tee, 3 Sprite Ball 75 cm)']) {
    assert.equal((await g(units, a, four)).pass, false, a);
  }
  assert.equal((await g('In the thread X, count the comments by Y.', 'Y wrote 3 comments (comment IDs: 1171393, 1171554, 1171600)', three)).pass, false);
  // the reference may come from answer_sql
  const query = async () => [{ n: 3 }];
  r = await grader.grade({ intent: 'Count the reviews', eval: { answer: { must_include: '$sql' }, answer_sql: 'SELECT 3' } }, { answer: '2 or 3', query });
  assert.equal(r.pass, false);
});

test('grader: task files (eval.files)', async () => {
  const grader = kit.grader;
  const db = new Database(':memory:');
  db.exec("CREATE TABLE v(id, name, email); INSERT INTO v VALUES ('V-1', 'Acme, Inc.', 'a@x.example'), ('V-2', 'Brightdesk', 'b@x.example')");
  const query = async (sql) => db.prepare(sql).all();
  const csv = { columns: ['Vendor ID', 'Email'], rows_sql: 'SELECT id, email FROM v' };
  const task = { input_files: [{ name: 'in.csv' }], eval: { type: 'files', files: [{ name: 'out.csv', csv }] } };
  const b64 = (s) => ({ base64: Buffer.from(s).toString('base64') });
  // any column order, extra columns, quoted cells, CRLF, BOM, case-insensitive name
  let r = await grader.grade(task, { query, files: { 'OUT.csv': b64('﻿name,email,vendor_id\r\n"Acme, Inc.",a@x.example,V-1\r\nBrightdesk,B@X.example,V-2\r\n') } });
  assert.equal(r.pass, true, JSON.stringify(r.checks));
  r = await grader.grade(task, { query, files: { 'out.csv': { text: 'Vendor ID,Email\nV-1,a@x.example\n' } } });
  assert.equal(r.pass, false); assert.deepEqual(r.checks[0].checks[0].missing, ['V-2']);
  r = await grader.grade(task, { query, files: { 'out.csv': { text: 'Vendor ID,Email\nV-1,a@x.example\nV-2,b@x.example\nV-2,b@x.example\nV-3,c@x.example\n' } } });
  assert.equal(r.pass, false); assert.deepEqual(r.checks[0].checks[0].duplicates, ['V-2']); assert.deepEqual(r.checks[0].checks[0].extra, ['V-3']);
  r = await grader.grade(task, { query, files: { 'out.csv': { text: 'Vendor ID,Email\nV-1,wrong@x.example\nV-2,b@x.example\n' } } });
  assert.equal(r.pass, false); assert.equal(r.checks[0].checks[0].mismatched[0].key, 'V-1');
  r = await grader.grade(task, { query, files: { 'out.csv': { text: 'ID,Email\nV-1,a@x.example\n' } } });
  assert.equal(r.pass, false); assert.deepEqual(r.checks[0].checks[0].missing_columns, ['Vendor ID']);
  r = await grader.grade(task, { query, files: {} });
  assert.equal(r.pass, false); assert.equal(r.checks[0].why, 'no such file');
  // no name: any file except the inputs; text checks reuse the answer matching
  const t2 = { input_files: [{ name: 'in.csv' }], eval: { files: [{ ext: '.csv', must_include: ['V-2'], must_exclude: ['V-9'] }] } };
  r = await grader.grade(t2, { files: { 'in.csv': { text: 'V-2' } } });
  assert.equal(r.pass, false);
  r = await grader.grade(t2, { files: { 'in.csv': { text: 'V-2' }, 'notes.csv': { text: 'id\nV-2\n' } } });
  assert.equal(r.pass, true);
  assert.deepEqual(grader.parseCsv('a,"b ""q"", c"\n\n1,2\n'), [['a', 'b "q", c'], ['1', '2']]);
});
