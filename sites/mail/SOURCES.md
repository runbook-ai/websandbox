# Mail data sources

All mail is synthetic. Nothing comes from real mailboxes.

- **People**: personas from NVIDIA *Nemotron-Personas-USA* (CC BY 4.0,
  https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA), via `world/` (see `world/README.md`).
  Names and short narratives are reused; addresses, employers, relationships and all mail are generated.
- **Mail text**: written per item spec by an open-weight LLM under MIT or Apache-2.0 (the render model is
  recorded in `world/render/models.json` and in the render cache shipped with the dataset). The
  published `base.db` (world seed `v1`: 20,000 personas, 300 mailboxes, 120 days, 457,590 rendered
  messages) was rendered by DeepSeek-V4.1-Flash (MIT), reasoning off, prompt version `p2`.
- **Organisations, newsletters, vendors, domains**: invented names (`world/lib/names.js`); every domain
  ends in `.example` (RFC 2606), so no address can reach a real mailbox.
- **System mail** (welcome, delivery failures, auto-replies): templates in `build/build.js` and `lib/mail.js`.

Build: `world/build-world.js` -> `world/render-world.js --net mail` -> `sites/mail/build/build.js`.
