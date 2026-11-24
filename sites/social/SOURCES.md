# Social data sources

- **Forum data** (the `community` network's base): the WebArena Postmill forum, unchanged, via
  `sites/forum` (see [../forum/SOURCES.md](../forum/SOURCES.md) for its origin and terms).
- **People**: personas from NVIDIA *Nemotron-Personas-USA* (CC BY 4.0,
  https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), via `world/` (see `world/README.md`).
  Names and short narratives are reused; handles, accounts, spaces, activity and all text are
  generated.
- **Posts and comments of world users** (community; devblog articles and comments; makers posts and
  comments; micro posts and replies): written per item spec by an open-weight LLM under MIT or
  Apache-2.0 (the render model is recorded in `world/render/models.json`; the published DB was
  rendered by DeepSeek-V4.1-Flash, MIT, and the rendered text ships with the dataset under `world/v1/`).
- **Direct messages** (community private messages, micro direct messages): conversations between world
  personas with a tie (replies, follows, same employer or group) from `world/sim/dms.js`, rendered by
  the same model (`world/render-dms.js`; the text ships under `world/v1/` as `rendered-dms.jsonl.zst`).
  Read state is drawn with the world's seeded RNG in `build/dms.js`. All synthetic; domains end in
  `.example`.
- **Engagement the specs don't carry** (devblog reactions and saves, makers upvotes, micro likes and
  reposts) and makers product taglines: drawn deterministically from the world's follow graph and
  reply threads in `build/migrate.js` (see `SCHEMA.md`).
- **Space metadata** (titles, about texts, rules, flair, posting limits): templates in
  `build/spaces.js`, drawn with the world's seeded RNG.
- No brand names, logos or stylesheets of real sites; the four frontends' looks (`sites/social`,
  `sites/devblog`, `sites/micro`, `sites/makers`) are written here.
