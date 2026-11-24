# world -- the seeded world behind the social and mail sites

The social sites (community, devblog, makers, micro) and mail render their content from one
deterministic world model: personas, organisations, relationships, an event timeline and a day-by-day
activity simulation. The simulation produces **item specs** (author, place, time, parent, topic,
intent, required facts); an LLM only writes the text of each spec. Graders depend on spec fields stored
in the site DBs, never on the text alone.

```
seed/import-personas.py   Nemotron-Personas-USA parquet -> personas-src.jsonl
spec/topics.json          topic taxonomy (keywords -> interests, spaces, tags, groups)
spec/networks.json        per-network membership, rates, item kinds, intents, lengths
lib/rng.js                seeded streams: rng(seed, label...) -- stable per entity
lib/names.js              invented names for projects, products, companies, venues
sim/personas.js           seed rows -> personas (interests, accounts, style card, tz)
sim/world.js              employers, projects, products, groups, newsletters, events, follows
sim/activity.js           day-by-day actions -> item specs (social) + mailbox specs (mail)
sim/dms.js                direct-message conversations between personas with a tie (community, micro)
build-world.js            CLI: build a world directory (no LLM calls)
build-dms.js              CLI: add dms.jsonl to a built world (additive, no LLM calls)
render/                   prompts, validators, OpenAI-compatible client, spec-hash cache
render-world.js           CLI: render a world's item specs (rendered-<net>.jsonl)
render-dms.js             CLI: render the direct messages (rendered-dms.jsonl)
pilot/pilot.js            render-model comparison with a blind judge
```

## Build

```sh
# 1. persona seeds (CC BY 4.0), one shard is ~90k personas
mkdir -p $WSB_WORK/world/src
curl -L -o $WSB_WORK/world/src/nemotron-00000.parquet \
  https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA/resolve/main/data/train-00000-of-00011.parquet
python3 -I world/seed/import-personas.py $WSB_WORK/world/personas-src.jsonl $WSB_WORK/world/src/nemotron-00000.parquet

# 2. the world (deterministic for a given --seed)
node world/build-world.js --seed w1 --personas 3000 --days 14 --out $WSB_WORK/world/w1

# 3. render (any OpenAI-compatible endpoint)
export WSB_LLM_URL=https://openrouter.ai/api/v1 WSB_LLM_KEY=...
node world/pilot/pilot.js --world $WSB_WORK/world/w1 --out $WSB_WORK/world/pilot/run1
```

## Direct messages

`build-dms.js` adds private conversations to a built world without touching it: it reads
`personas.jsonl`, `world.json` and `items.jsonl` and writes only `dms.jsonl`, so the items and every
rendered file stay byte-identical. Only the networks with a DM UI get them: community (private
messages with a subject) and micro (direct messages). About 1 in 5 active accounts starts 1-3
conversations with someone it has a tie to -- replies to each other's posts, follows (micro), the same
employer or meetup group -- weighted by the tie's strength; one conversation per pair, 2-8 messages,
answers minutes to a day apart, sometimes two in a row from the same person. The opening message's
intent decides its facts (written verbatim, kept in the spec for graders): `about-post` (the
recipient's post the sender replied to; `ref` = its item id), `work-ask` (a deadline), `group-plan`
(the group's name), `meet-up` (a day and time, and a venue), `borrow` (the thing), `recommend`,
`catch-up`. Read / unread state is decided when the site DB is built (`sites/social/build/dms.js`).

```sh
node world/build-dms.js --world $WSB_WORK/world/w1                  # -> dms.jsonl
node world/render-dms.js --world $WSB_WORK/world/w1 --threads 40   # pilot: cost per message
node world/render-dms.js --world $WSB_WORK/world/w1                 # -> rendered-dms.jsonl
```

The DM prompts (`render/prompts.js` `buildDM`) give the sender's persona, the recipient's first name
and city, how they know each other, the conversation so far and the post it is about; the validator
also rejects links, e-mail addresses (other than `.example`), phone numbers and street addresses.

## Determinism and the cache

Every random draw comes from `rng(seed, <entity labels>)`, so adding a persona or a network doesn't
shift anyone else's draws. Rendered text is cached by `sha256(model, prompt version, messages)`; the
messages embed the parent's text, so changing one item re-renders only it and its replies. Same seed +
same cache = same corpus with no LLM calls.

## Render model

Published text must come from an open-weight model under MIT or Apache-2.0 (see `render/models.json`),
so the generated corpus carries no output-use restrictions. A judge model used only for scoring may be
any model.

## Attribution

Persona seeds: NVIDIA, *Nemotron-Personas-USA*, CC BY 4.0
(https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA). Personas are synthetic; names and
narratives are re-used, accounts, handles and all activity are generated here.
