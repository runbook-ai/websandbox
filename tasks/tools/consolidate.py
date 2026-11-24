#!/usr/bin/env python3
"""Consolidate every task file into tasks/all.jsonl + tasks/dropped.jsonl and write the
template-disjoint train / held-out splits (tasks/splits/, method in tasks/splits/SPLITS.md).

    python3 -I tasks/tools/consolidate.py [--seed 20261115]

Deterministic for a given seed and task files. WebArena templates keep the RL stack's stage-2
assignment (tasks/splits/old-rl-split.json); templates it never assigned (map / wikipedia /
cross-site with them, and Lite-only templates) and generated templates are held out by a seeded,
stratified draw (~25% WebArena, ~20% generated per site).
"""
import collections
import json
import os
import random
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SEED = int(sys.argv[sys.argv.index('--seed') + 1]) if '--seed' in sys.argv else 20261115
WA_FRAC, GEN_FRAC = 0.25, 0.20

FILES = [
    ('webarena', 'tasks/forum/webarena.jsonl'), ('webarena', 'tasks/store/webarena-shopping.jsonl'),
    ('webarena', 'tasks/store/webarena-admin.jsonl'), ('webarena', 'tasks/code/webarena-a.jsonl'),
    ('webarena', 'tasks/code/webarena-b.jsonl'), ('webarena', 'tasks/map/webarena.jsonl'),
    ('webarena', 'tasks/cross/webarena.jsonl'),
    ('generated', 'tasks/forum/generated.jsonl'), ('generated', 'tasks/store/generated-shopping.jsonl'),
    ('generated', 'tasks/store/generated-admin.jsonl'), ('generated', 'tasks/code/generated.jsonl'),
    ('generated', 'tasks/wiki/generated.jsonl'), ('generated', 'tasks/map/generated.jsonl'),
    # newer sites (appended last so the earlier sites' seeded draws are unchanged)
    ('generated', 'tasks/mail/generated.jsonl'), ('generated', 'tasks/lab/generated.jsonl'),
    ('generated', 'tasks/social/generated.jsonl'),
    ('generated', 'tasks/devblog/generated.jsonl'), ('generated', 'tasks/micro/generated.jsonl'),
    ('generated', 'tasks/makers/generated.jsonl'),
    # widget variants of generated tasks (tasks/variants/gen.js): last, and never part of a draw
    ('generated', 'tasks/variants/generated.jsonl'),
]
# Variant rows (variant_of = a base task id) take their base task's split, except that one widget
# kind is held out on every site: variants using it are held out whatever their base's split.
HELDOUT_WIDGET_VALUE = 'sections'
GRADER_DIR = {'shopping': 'store', 'shopping_admin': 'store', 'gitlab': 'code', 'forum': 'forum', 'reddit': 'forum',
              'wiki': 'wiki', 'map': 'map', 'mail': 'mail', 'lab': 'lab', 'social': 'social',
              'devblog': 'devblog', 'micro': 'micro', 'makers': 'makers'}
SITE_ORDER = ['shopping', 'shopping_admin', 'forum', 'gitlab', 'wiki', 'map', 'mail', 'lab', 'social', 'devblog', 'micro', 'makers']


def jl(path):
    with open(os.path.join(ROOT, path), encoding='utf-8') as f:
        return [json.loads(l) for l in f if l.strip()]


def types_of(ev):
    t = ev.get('type')
    t = list(t) if isinstance(t, list) else [t] if t else []
    if not t:
        if ev.get('answer') or ev.get('answer_sql'): t.append('answer')
        if ev.get('url'): t.append('url')
        if ev.get('state_sql') or ev.get('state'): t.append('state')
        t += [m for m in ('directions', 'place', 'search') if ev.get(m)]
    if ev.get('state') and 'state' not in t: t.append('state')
    return t


# WebArena tasks carry no skills/difficulty: derive them from the eval and the intent (heuristic,
# documented in SPLITS.md); generated tasks keep their own.
KW = [
    ('search', r'\b(search|look up|find|lookup)\b'),
    ('filter-sort', r'\b(most|least|top|cheapest|lowest|highest|latest|newest|oldest|recent|best|worst|sort|first|last|largest|smallest|max|min)\b'),
    ('aggregate', r'\b(how many|how much|total|count|number of|sum|spent|spend|amount)\b'),
    ('compare', r'\b(compare|comparison|difference|between|which .* (more|less|closer|faster|longer))\b'),
    ('create', r'\b(create|post|open an issue|submit|new|add|draft|fork|make a|start a|invite|write|reply|comment|leave a)\b'),
    ('form-edit', r'\b(change|update|edit|set|modify|mark|cancel|delete|remove|rename|assign|close|disable|enable|approve|reject|like|upvote|downvote|subscribe|follow|star|archive|replace)\b'),
]


def wa_skills(t, types):
    intent = t['intent'].lower()
    sk = [s for s, rx in KW if re.search(rx, intent)]
    if 'state' in types:
        if not ({'create', 'form-edit'} & set(sk)): sk.append('form-edit')
    else:
        sk = [s for s in sk if s not in ('create', 'form-edit')]
    if 'answer' in types and 'state' not in types: sk.append('read-detail')
    if set(types) & {'url', 'directions', 'place', 'search'}: sk.append('navigate')
    if t.get('site') == 'cross' or len(types) > 1: sk.append('multi-step')
    order = ['search', 'navigate', 'read-detail', 'filter-sort', 'aggregate', 'compare', 'create', 'form-edit', 'multi-step']
    return [s for s in order if s in set(sk)]


def wa_difficulty(t, types, skills):
    if t.get('site') == 'cross': return 3
    n_state = len(t['eval'].get('state_sql') if isinstance(t['eval'].get('state_sql'), list) else [1] if t['eval'].get('state_sql') else [])
    if 'state' in types and (n_state > 1 or 'multi-step' in skills): return 3
    if 'state' in types or 'aggregate' in skills or 'compare' in skills or len(types) > 1: return 2
    return 1


def normalise(source, path, t):
    ev = t['eval']
    types = types_of(ev)
    site = t['site']
    sites = t.get('sites') or [site]
    grade_site = t.get('grade_site') or site
    gdir = GRADER_DIR.get(grade_site, grade_site)
    grader = f'sites/{gdir}/grade.js' if os.path.exists(os.path.join(ROOT, 'sites', gdir, 'grade.js')) else 'kit/lib/grader.js'
    if source == 'webarena':
        tid = f"wa-{t['task_id']}"
        template = f"wa-t{t['intent_template_id']}"
        skills = wa_skills(t, types)
        difficulty = wa_difficulty(t, types, skills)
    else:
        tid = t['task_id']
        template = t['template']
        skills = t.get('skills') or []
        difficulty = t.get('difficulty')
    out = {
        'id': tid, 'source': source, 'template': template, 'site': site, 'sites': sites, 'grade_site': grade_site,
        'grader': grader, 'intent': t['intent'], 'start_url': t['start_url'], 'require_login': bool(t.get('require_login')),
        'login_user': t.get('login_user'), 'eval': ev, 'eval_types': types,
        'kind': t.get('kind') or ('write' if 'state' in types else 'read'),
        'skills': skills, 'difficulty': difficulty,
        'task_id': t['task_id'], 'intent_template_id': t.get('intent_template_id'), 'intent_template': t.get('intent_template'),
        'instantiation_dict': t.get('instantiation_dict'), 'file': path,
    }
    for k in ('reference_answer', 'reference_url', 'ref', 'evidence', 'reference_sql', 'original_intent', 'phrasing',
              'scenario', 'aids', 'aid_variant', 'family', 'split_hint', 'heldout_reason', 'variant_of', 'widget',
              'input_files', 'modality'):
        if k in t: out[k] = t[k]
    out['changes'] = t.get('changes') or []
    if t.get('status') == 'dropped': out['drop_reason'] = t.get('drop_reason')
    return out


def stratum(r):
    return '+'.join(sorted(r['sites'])) if r['site'] == 'cross' else r['site']


def pick_holdout(templates, frac, rnd, cover=None):
    """templates: {tpl: rows}. Seeded draw of round(frac * n) templates (>= 1 when n >= 3); with
    `cover`, greedy so the held-out set covers read and write and each skill that >= 2 templates have."""
    keys = sorted(templates)
    n = len(keys)
    k = max(1 if n >= 3 else 0, int(round(frac * n)))
    if not k: return set()
    order = keys[:]
    rnd.shuffle(order)
    if not cover:
        return set(order[:k])
    feats = {}
    for tp in keys:
        rows = templates[tp]
        f = {'kind:' + r['kind'] for r in rows} | {'skill:' + s for r in rows for s in r['skills']}
        feats[tp] = f
    count = collections.Counter(x for f in feats.values() for x in f)
    want = {x for x, c in count.items() if c >= 2}
    kinds = {tp: 'write' if 'kind:write' in feats[tp] else 'read' for tp in keys}
    target_w = sum(1 for tp in keys if kinds[tp] == 'write') / n
    chosen = []
    while len(chosen) < k:
        w = sum(1 for c in chosen if kinds[c] == 'write')
        # tie-break: keep the held-out read/write mix close to the site's
        short = 'write' if (w + 1) / (len(chosen) + 1) <= target_w + 1e-9 else 'read'
        missing = want - set().union(*[feats[c] for c in chosen]) if chosen else set(want)
        best, gain = None, -1
        for tp in order:  # seeded order breaks ties
            if tp in chosen: continue
            # never take the last template of a feature away from train
            if any(count[x] - sum(1 for c in chosen if x in feats[c]) <= 1 for x in feats[tp] if x in want): g = -0.5
            else: g = len(feats[tp] & missing) + (0.25 if kinds[tp] == short else 0)
            if g > gain: best, gain = tp, g
        if best is None: break
        chosen.append(best)
    return set(chosen)


def main():
    old = json.load(open(os.path.join(ROOT, 'tasks/splits/old-rl-split.json')))
    old_train_t, old_held_t = set(old['train_templates']), set(old['heldout_templates'])
    old_train_ids, old_held_ids, old_lite_ids = set(old['train_task_ids']), set(old['heldout_task_ids']), set(old['lite_task_ids'])
    rows, dropped = [], []
    for source, path in FILES:
        if not os.path.exists(os.path.join(ROOT, path)): continue
        for t in jl(path):
            r = normalise(source, path, t)
            if source == 'webarena':
                r['old_rl'] = ('train' if t['task_id'] in old_train_ids else 'heldout' if t['task_id'] in old_held_ids
                               else 'lite' if t['task_id'] in old_lite_ids else 'unhosted')
            (dropped if t.get('status') == 'dropped' else rows).append(r)
    ids = [r['id'] for r in rows + dropped]
    assert len(ids) == len(set(ids)), 'duplicate ids'

    rnd = random.Random(SEED)
    split = {}
    why = {}
    # (a) WebArena: stage-2 assignment, then a seeded stratified draw for the rest
    wa = collections.defaultdict(list)
    for r in rows:
        if r['source'] == 'webarena': wa[r['template']].append(r)
    rest = collections.defaultdict(dict)
    for tp, rs in wa.items():
        tid = rs[0]['intent_template_id']
        if tid in old_held_t: split[tp], why[tp] = 'heldout', 'old-heldout'
        elif tid in old_train_t: split[tp], why[tp] = 'train', 'old-train'
        else: rest[stratum(rs[0])][tp] = rs
    for st in sorted(rest):
        h = pick_holdout(rest[st], WA_FRAC, rnd)
        for tp in rest[st]:
            split[tp], why[tp] = ('heldout' if tp in h else 'train'), 'new-draw'
    # (b) generated: per site, ~20% of templates, covering read/write and skills
    gen = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        if r['source'] == 'generated' and not r.get('variant_of'): gen[r['site']][r['template']].append(r)
    # Templates added to a site after its draw (not in the previous templates.json) do not join it,
    # so the existing assignment stays as it was: they get a draw of their own per site ('gen-draw-added').
    prev_file = os.path.join(ROOT, 'tasks/splits/templates.json')
    prev = json.load(open(prev_file))['templates'] if os.path.exists(prev_file) else {}
    for site in SITE_ORDER:
        if site not in gen: continue
        hints = {tp: rs[0].get('split_hint') for tp, rs in gen[site].items()}
        if all(hints.values()):  # the generator assigned its own template-disjoint split (lab)
            for tp in gen[site]:
                split[tp], why[tp] = hints[tp], 'gen-hint'
            continue
        known = {tp: rs for tp, rs in gen[site].items() if not prev or (tp in prev and prev[tp]['why'] == 'gen-draw')}
        h = pick_holdout(known, GEN_FRAC, rnd, cover=True)
        for tp in known:
            split[tp], why[tp] = ('heldout' if tp in h else 'train'), 'gen-draw'
            assert not prev or prev[tp]['split'] == split[tp], f'{tp}: split changed'
        added = {tp: rs for tp, rs in gen[site].items() if tp not in known}
        if added:
            h = pick_holdout(added, GEN_FRAC, random.Random(f'{SEED}/{site}/added'), cover=True)
            for tp in added:
                split[tp], why[tp] = ('heldout' if tp in h else 'train'), 'gen-draw-added'
    by_id = {}
    for r in rows:
        if r.get('variant_of'): continue
        r['split'] = split[r['template']]
        by_id[r['id']] = r
    for r in rows:
        if not r.get('variant_of'): continue
        assert r['variant_of'] in by_id, 'variant of an unknown task: ' + r['id']
        held = (r.get('widget') or {}).get('value') == HELDOUT_WIDGET_VALUE
        r['split'] = 'heldout' if held else by_id[r['variant_of']]['split']
    # template-disjointness (base tasks; a variant follows its base task, or the held-out widget kind)
    tsplit = collections.defaultdict(set)
    for r in rows:
        if not r.get('variant_of'): tsplit[r['template']].add(r['split'])
    assert all(len(v) == 1 for v in tsplit.values())
    assert all(r['split'] == ('heldout' if (r.get('widget') or {}).get('value') == HELDOUT_WIDGET_VALUE else by_id[r['variant_of']]['split']) for r in rows if r.get('variant_of'))

    def write(path, rs):
        p = os.path.join(ROOT, path)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            for r in rs: f.write(json.dumps(r, ensure_ascii=False) + '\n')
    write('tasks/all.jsonl', rows)
    write('tasks/dropped.jsonl', dropped)
    tr = [r for r in rows if r['split'] == 'train']
    he = [r for r in rows if r['split'] == 'heldout']
    write('tasks/splits/train.jsonl', tr)
    write('tasks/splits/heldout.jsonl', he)
    write('tasks/splits/heldout-webarena.jsonl', [r for r in he if r['source'] == 'webarena'])
    write('tasks/splits/heldout-generated.jsonl', [r for r in he if r['source'] == 'generated'])
    json.dump({'seed': SEED, 'templates': {tp: {'split': split[tp], 'why': why[tp]} for tp in sorted(split)}},
              open(os.path.join(ROOT, 'tasks/splits/templates.json'), 'w'), indent=0, sort_keys=True)
    write_md(rows, dropped, split, why, old)
    print(f'all {len(rows)} (dropped {len(dropped)}): train {len(tr)}, heldout {len(he)}')


def table(head, data):
    out = ['| ' + ' | '.join(head) + ' |', '|' + '---|' * len(head)]
    out += ['| ' + ' | '.join(str(x) for x in row) + ' |' for row in data]
    return '\n'.join(out)


def write_md(rows, dropped, split, why, old):
    C = collections.Counter
    def cnt(key):
        c = C()
        for r in rows: c[(key(r), r['split'])] += 1
        return c
    by_site = cnt(lambda r: (r['source'], stratum(r)))
    keys = sorted({k for k, _ in by_site})
    tpl_counts = collections.defaultdict(lambda: C())
    seen = set()
    for r in rows:
        if r['template'] in seen: continue
        seen.add(r['template']); tpl_counts[(r['source'], stratum(r))][r['split']] += 1
    site_rows = [(src, st, tpl_counts[(src, st)]['train'], tpl_counts[(src, st)]['heldout'], by_site[((src, st), 'train')],
                  by_site[((src, st), 'heldout')]) for src, st in keys]
    tot = lambda src, sp: sum(1 for r in rows if (src is None or r['source'] == src) and r['split'] == sp)
    ttot = lambda src, sp: len({r['template'] for r in rows if (src is None or r['source'] == src) and r['split'] == sp})
    site_rows.append(('**all**', '', ttot(None, 'train'), ttot(None, 'heldout'), tot(None, 'train'), tot(None, 'heldout')))
    sk = C(); kd = C(); df = C()
    for r in rows:
        for s in r['skills']: sk[(s, r['source'], r['split'])] += 1
        kd[(r['kind'], r['source'], r['split'])] += 1
        df[(r['difficulty'], r['source'], r['split'])] += 1
    skills = sorted({s for s, _, _ in sk})
    sk_rows = [(s, sk[(s, 'webarena', 'train')], sk[(s, 'webarena', 'heldout')], sk[(s, 'generated', 'train')], sk[(s, 'generated', 'heldout')]) for s in skills]
    kd_rows = [(k, kd[(k, 'webarena', 'train')], kd[(k, 'webarena', 'heldout')], kd[(k, 'generated', 'train')], kd[(k, 'generated', 'heldout')]) for k in ('read', 'write')]
    df_rows = [(d, df[(d, 'webarena', 'train')], df[(d, 'webarena', 'heldout')], df[(d, 'generated', 'train')], df[(d, 'generated', 'heldout')]) for d in (1, 2, 3)]
    # old RL mapping
    om = C()
    for r in rows:
        if r['source'] == 'webarena': om[(r['old_rl'], r['split'])] += 1
    om_rows = [(k, om[(k, 'train')], om[(k, 'heldout')]) for k in ('train', 'heldout', 'lite', 'unhosted')]
    dropped_old = C(r['old_rl'] for r in dropped)
    wa_tpl = sorted({r['template'] for r in rows if r['source'] == 'webarena'}, key=lambda x: int(x[4:]))
    def tl(src, sp, w=None):
        ts = sorted({r['template'] for r in rows if r['source'] == src and r['split'] == sp and (w is None or why[r['template']] == w)},
                    key=lambda x: (int(x[4:]) if src == 'webarena' else x))
        return ', '.join(f'`{t}`' for t in ts) or '--'
    gen_lists = []
    for site in SITE_ORDER:
        h = sorted({r['template'] for r in rows if r['source'] == 'generated' and r['site'] == site and r['split'] == 'heldout'})
        t = sorted({r['template'] for r in rows if r['source'] == 'generated' and r['site'] == site and r['split'] == 'train'})
        if h or t: gen_lists.append(f'- **{site}** held out ({len(h)}): ' + ', '.join(f'`{x}`' for x in h) + f'\n  - train ({len(t)}): ' + ', '.join(f'`{x}`' for x in t))
    newdraw = collections.defaultdict(lambda: {'train': [], 'heldout': []})
    for r in rows:
        if r['source'] == 'webarena' and why[r['template']] == 'new-draw' and r['template'] not in newdraw[stratum(r)][r['split']]:
            newdraw[stratum(r)][r['split']].append(r['template'])
    nd_rows = [(st, len(v['train']), len(v['heldout']), ', '.join(f'`{x}`' for x in sorted(v['heldout'], key=lambda x: int(x[4:]))) or '--') for st, v in sorted(newdraw.items())]

    vc = C()
    for r in rows:
        if r.get('variant_of'): vc[(r['site'], r['widget']['slot'], r['split'])] += 1
    var_keys = sorted({(a, b) for a, b, _ in vc})
    var_rows = [(a, b, vc[(a, b, 'train')], vc[(a, b, 'heldout')]) for a, b in var_keys]
    if var_rows: var_rows.append(('**all**', '', sum(x[2] for x in var_rows), sum(x[3] for x in var_rows)))
    md = f"""# Train / held-out splits

Generated by `python3 -I tasks/tools/consolidate.py` (seed **{SEED}**) from the task files listed in
[../tools/consolidate.py](../tools/consolidate.py); deterministic for a seed and the task files. Do not edit by hand.

Files: [train.jsonl](train.jsonl), [heldout.jsonl](heldout.jsonl) = [heldout-webarena.jsonl](heldout-webarena.jsonl) +
[heldout-generated.jsonl](heldout-generated.jsonl); [templates.json](templates.json) (template -> split and why);
[old-rl-split.json](old-rl-split.json) (the RL stack's stage-2 split). Every row is a line of
[../all.jsonl](../all.jsonl) with `split` set; dropped tasks are in [../dropped.jsonl](../dropped.jsonl).

**Template-disjoint:** no template has tasks in both splits (checked by the script). Template keys: WebArena
`wa-t<intent_template_id>`, generated `gen-<site>-<name>`; WebArena and generated templates never share a key
(generated families were written independently, but some ask similar kinds of questions on the same sites).

## Method

**WebArena tasks** keep the RL stack's stage-2 assignment: its dataset builder
built a train set (train = the 441 non-Lite tasks whose template is also in WebArena-Lite, hosted sites only;
`heldout.jsonl` = the 103 non-Lite tasks of the 22 templates not in Lite); the training jobs
copy that held-out file to their eval set, which the checkpoint eval evaluates
(`EVAL_SETS=heldout`), and train on a pass-rate-filtered subset of `train.jsonl`. Here:
- templates of the old held-out set (22) -> **heldout**; templates of the old train set (116; they include the
  Lite tasks of those templates) -> **train**;
- every other WebArena template (the old stack never trained or held them out: map, wikipedia, cross-site tasks
  with them, and hosted templates whose only tasks are Lite tasks) -> a seeded draw of ~{int(WA_FRAC*100)}% held out per
  stratum (site, or the sorted site set of a cross-site task); strata with < 3 templates stay train.

**Generated tasks:** per site, ~{int(GEN_FRAC*100)}% of the templates held out by a seeded greedy draw that makes the
held-out set cover read and write tasks and every skill that at least two of the site's templates have, without
taking the last template of a skill or kind away from train. Templates added to a site later (not in the
previous templates.json, e.g. the direct-message templates of social and micro) keep the existing assignment
as it is and get a draw of their own per site, the same way (`why`: `gen-draw-added`).

**Skills / difficulty of WebArena tasks** are heuristic (WebArena has none): skills from the eval types (state ->
form-edit/create, answer -> read-detail, url/map checks -> navigate, cross-site or several check types ->
multi-step) plus intent keywords (search / filter-sort / aggregate / compare / create / form-edit); difficulty 3 =
cross-site or a multi-check write, 2 = a write, an aggregate/compare or several check types, 1 = otherwise.
Generated tasks keep their generator's skills and difficulty.

## Counts

{len(rows)} tasks ({sum(1 for r in rows if r['source']=='webarena')} WebArena + {sum(1 for r in rows if r['source']=='generated')} generated), {len(dropped)} dropped.
Train {tot(None,'train')} tasks / {ttot(None,'train')} templates; held-out {tot(None,'heldout')} tasks / {ttot(None,'heldout')} templates
(WebArena {tot('webarena','heldout')} tasks / {ttot('webarena','heldout')} templates; generated {tot('generated','heldout')} / {ttot('generated','heldout')}).

### By source and site

{table(['source', 'site(s)', 'train templates', 'held-out templates', 'train tasks', 'held-out tasks'], site_rows)}

### By kind, difficulty and skill (tasks)

{table(['kind', 'WA train', 'WA held-out', 'gen train', 'gen held-out'], kd_rows)}

{table(['difficulty', 'WA train', 'WA held-out', 'gen train', 'gen held-out'], df_rows)}

{table(['skill', 'WA train', 'WA held-out', 'gen train', 'gen held-out'], sk_rows)}

## Mapping to the old RL split (WebArena tasks)

`old_rl` on each row: the task's role in the RL stack's dataset (train / heldout / lite = WebArena-Lite eval /
unhosted = map or wikipedia, never on the RL node).

{table(['old role', 'now train', 'now held-out'], om_rows)}

Dropped WebArena tasks by old role: {dict(dropped_old)}. Every old held-out task that was not dropped is in the new
held-out set and every old train task is in train; a Lite task follows its template (train for the 116 shared
templates; the seeded draw otherwise).

Old stage-2 held-out templates (-> heldout): {tl('webarena', 'heldout', 'old-heldout')}

Old train templates (-> train): {tl('webarena', 'train', 'old-train')}

### Templates the old setup never assigned (seeded draw)

{table(['stratum', 'train templates', 'held-out templates', 'held out'], nd_rows)}

## Generated templates

{chr(10).join(gen_lists)}

## Widget variants

Rows with `variant_of` (from [../variants/generated.jsonl](../variants/generated.jsonl), docs/WIDGETS.md) are copies of
generated tasks with a `scenario` that turns one widget slot on; they keep their base task's template and
split, except that every variant using the widget kind `{HELDOUT_WIDGET_VALUE}` is held out (so that list kind is never
trained on). The template-disjointness check covers the base tasks; base tasks' splits do not depend on the
variants (they are read last and take no part in the draws).

{table(['site', 'slot', 'train', 'held-out'], var_rows) if var_rows else 'None.'}
"""
    open(os.path.join(ROOT, 'tasks/splits/SPLITS.md'), 'w').write(md)


if __name__ == '__main__':
    main()
