# Social data sources

- **Forum data** (the `community` network's base): the WebArena Postmill forum, unchanged, via
  `sites/forum` (see [../forum/SOURCES.md](../forum/SOURCES.md) for its origin and terms).
- **People**: personas from NVIDIA *Nemotron-Personas-USA* (CC BY 4.0,
  https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), via `world/` (see `world/README.md`).
  Names and short narratives are reused; handles, accounts, spaces, activity and all text are
  generated.
- **Posts and comments of world users**: written per item spec by an open-weight LLM under MIT or
  Apache-2.0 (the render model is recorded in `world/render/models.json` and in the render cache
  shipped with the dataset).
- **Space metadata** (titles, about texts, rules, flair, posting limits): templates in
  `build/spaces.js`, drawn with the world's seeded RNG.
- No brand names, logos or stylesheets of real sites; the frontend's look is written here.
