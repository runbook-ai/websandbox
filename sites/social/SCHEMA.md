# Social schema

`base.db` of the social site = the forum's `base.db` ([../forum/SCHEMA.md](../forum/SCHEMA.md)),
extended **additively** by [build/schema.sql](build/schema.sql) and loaded with the world model's
networks by [build/migrate.js](build/migrate.js) (community) and [build/networks.js](build/networks.js)
(devblog, makers, micro). One DB, one set of users, content partitioned by network (`networks`):
the WebArena forum data is the `community` network unchanged, and each network grows from the
world model (`world/`). Four frontends run on it, each its own kit site filtered to one network:

| Site | Network | Frontend |
|---|---|---|
| `sites/social` | 1 `community` | "Commonroom": topic communities ([ROUTES.md](ROUTES.md)) |
| `sites/devblog` | 2 `devblog` | "Byteline": developer articles ([../devblog/ROUTES.md](../devblog/ROUTES.md)) |
| `sites/makers` | 3 `makers` | "Workbench": indie founders and products ([../makers/ROUTES.md](../makers/ROUTES.md)) |
| `sites/micro` | 4 `micro` | "Murmur": short posts ([../micro/ROUTES.md](../micro/ROUTES.md)) |

The other frontends' data dirs hold a `base.db` symlink to this DB and a `media` symlink
(`$WSB_DATA_ROOT/devblog/base.db -> ../social/base.db`); each process opens it in overlay mode like
any kit site.

## Additive-only rule

The converted WebArena forum tasks carry submission/comment ids in URLs and SQL in graders. The
migration therefore only adds tables and nullable/defaulted columns, and appends rows after the
existing max ids. `migrate.js` checks this before it finishes: every pre-existing table is
fingerprinted on the source and on the result (row hashes of `users`, `forums`, `submissions` and
the small tables over the source's columns; aggregates of `comments` and `user_stats`; indexes,
triggers and views unchanged; no new moderator / subscription / notification / mod-log rows on
pre-existing forums or users). The build fails if anything differs.

World spaces whose name already is a WebArena forum (`books`, `movies`, `DIY`, `gaming`, ...) get
a space of their own (`bookclub`, `filmbuffs`, `diyprojects`, `videogames`, ...; `build/spaces.js`
`ALIAS`): forum tasks read those forums ("the newest post in books"), so world posts never land
in them. The forum frontend (`sites/forum`) runs unchanged on this DB; its forum-scoped pages show
exactly the old rows. Its site-wide views (front page, `/comments`, search time windows) also list
the 2026-dated world rows, because the forum clock is 2023-07-11.

## Build

```
node sites/social/build/migrate.js --forum $WSB_DATA_ROOT/forum/base.db --world $WSB_WORK/world/w1 \
  [--rendered <world>/rendered-community.jsonl] --out $WSB_DATA_ROOT/social [--now '2026-10-14 18:00:00'] \
  [--nets community,devblog,makers,micro]
```

Needs a rendered world (`world/build-world.js`, then `world/render-world.js --net <net>` per
network). A network whose `<world>/rendered-<net>.jsonl` is missing is skipped with a warning (a
build without micro still works); `--nets` picks networks explicitly (community is always loaded:
it creates the users and accounts of every network).
Copies the forum DB to `<out>/base.db.tmp` (never writes the source), migrates, checks, finalizes
(ANALYZE, VACUUM, integrity check) and renames it to `<out>/base.db`; `<out>/media` is a symlink to
the forum's media. Deterministic: the same forum DB + world + rendered text give the same rows.
About 1 minute and ~1.3 GB of free disk.

## Networks and new columns

| Table / column | Notes |
|---|---|
| `networks` | 1 `community`, 2 `devblog`, 3 `makers`, 4 `micro` (`max_chars` 280) |
| `forums.network_id` | default 1; also `about` (sidebar text), `icon_color` |
| `submissions.network_id` | default 1 (every forum row is `community`); also `kind` (NULL = classic link/text/image; `article` devblog, `thread-post` makers, `short` / `reply` micro), `status` (`published` default, `draft`, `scheduled`), `published_at`, `reading_time`, `cover_image_id`, `series_id`, `quote_of`, `repost_of`, `flair_id`, `reply_to` + `root_id` (micro replies: the post replied to and the conversation's first post), `product_id` (makers: a founder's post about their product). Rows of the other networks keep `net_score` 0 (their likes / upvotes are `reactions`), so community karma (`user_stats`) is unchanged |
| `forums` of other networks | `net_devblog`, `net_makers`, `net_micro` (containers, `submissions.forum_id` is NOT NULL) and the makers groups `makers_<slug>` (network 3; members in `forum_subscriptions`) |
| `message_threads.network_id` | default 1; micro direct messages are 4 |
| `users.persona_id` | world persona id (`p000123`) of world users; never shown, for generators and graders |
| `notifications.actor_id`, `.network_id` | who caused it; network (default 1). New types besides the forum's `comment` / `comment_mention` / `submission_mention` / `message`: `follow`, `reaction` (devblog reactions, makers upvotes), `mention`, and on micro `reply`, `like`, `repost`, `quote` |

## New tables

| Table | Notes |
|---|---|
| `accounts` | user x network profile: `handle` (unique per network, case-insensitive), `display_name`, `avatar_color`, `bio`, `joined_at`. World users only; a community account's handle = `users.username` |
| `follows` | (network, follower, followee) |
| `bookmarks`, `reposts` | (user, submission) |
| `reactions`, `reaction_counts` | typed reactions beside votes; counts kept by triggers |
| `tags`, `post_tags`, `tag_follows`, `series` | devblog: the article specs' tags, members following 2-5 tags of their topics, series = an author's 3+ articles on one topic |
| `products`, `product_milestones` | makers: the world model's products (`slug`, `name`, `tagline`, `topic`, `founder_id`, `mrr` monthly revenue in USD, `launched_at`); milestones = the launch plus founders' milestone / revenue-update / launch posts (`value` = the spec fact, e.g. `$958 MRR`, `120 users`), and ones founders add |
| `world_affiliations` | hidden: `(persona_id, kind, name, topic, ord)` -- who founded which product, maintains which project, works at which employer (world model order); for generators and graders |
| `space_rules` | per forum, ordered by `position`; `kind` = `text` or a gradable kind (below), `param` |
| `flairs` | per forum: `name`, `color`, `mod_only`; posts point at one by `submissions.flair_id` |
| `posting_limits` | per network (or per forum): `action` (`submission`/`comment`), `max_count` per `window_seconds`, optionally only for accounts younger than `account_age_below_days` |
| `scheduled_events` | `network_id`, `fire_at`, `kind` (community `world.post`, `world.comment`, `notification`, `vote`; `devblog.article`, `devblog.comment`, `makers.post`, `makers.comment`, `micro.post`, `micro.reply`), JSON `payload`, `fired_at`, `result_id`. Each frontend fires its own network's events only |
| `world_items` | world item spec -> row (`row_table`, `row_id`), persona, topic, intent, required facts, event; hidden |
| FTS5 `accounts_fts`, `tags_fts`, `space_rules_fts` | external content, kept current by triggers (the forum's `submissions_fts` / `comments_fts` / `forums_fts` cover the new rows too) |
| `site_settings` `social_now`, `social_world`, `social_world_seed` | the build's base "now" and world |

**Rule kinds** (`space_rules.kind`, `param`): `no-self-promo` (not enforced by the site; graders
check posts for the poster's own product/project/employer), `flair-required` (enforced),
`min-account-age` (days, enforced), `min-karma` (points of `user_stats` post + comment karma,
enforced), `no-links` (no link posts and no URLs in title/body, enforced), `title-format` (JSON
`{pattern, example}`, title must match the regex, enforced), `text` (not checkable). Every forum,
old and new, has 2-4 text rules plus a seeded draw of the gradable kinds; `explainlikeimfive`
requires `ELI5: ` titles and `ask*` forums question titles. World posts made before a rule are
not re-checked (a "find posts that break rule N" task can use that).

**Posting limits**: community: 6 comments / 10 min, 3 posts / hour; accounts under 7 days 1
post / day, under 2 days 10 comments / day; ~12% of forums 1 post / day. devblog: 5 published
articles / day, 10 comments / 10 min. makers: 2 posts / day, 10 comments / 10 min. micro: 50 posts
/ hour and 50 replies / hour; posts at most 280 characters (`networks.max_chars`).

## The other networks (build/networks.js)

| Network | From the world model | Derived (seeded) |
|---|---|---|
| devblog | articles (title, body, tags, `reading_time` = words / 220), comment trees, follows (`world.follows.devblog`), accounts | reactions (`like`, `unicorn`, `insightful`, `funny`, `fire`) by the author's followers, commenters and members of the topic; reading-list `bookmarks`; tag follows; series |
| makers | posts (group = the spec's space, `product_id` when a founder's post names their product), comment trees, groups, products (founder, MRR, launch), follows | `upvote` reactions; group memberships; milestones from founders' posts |
| micro | posts and replies, follows | `like` reactions, `reposts` (about 12% of likers), a few bookmarks |

The world specs carry no likes, reactions or reposts: these are drawn per item from the follow
graph and the reply threads (`rng(seed, ...)`), so counts are real rows a grader can query.
Follows are dated between the later of the two accounts' joins and the build's "now";
notifications: replies and comments (older ones mostly read), follows inside the world window,
likes / reactions / upvotes / reposts of the last 3 days.

## Rows (dev world `w1`: 3,000 personas, 14 days)

| | Rows |
|---|---|
| users | 661,782 + 3,000 world users (ids 671,781 .. 674,780) |
| accounts | 4,469 (community 2,032, devblog 623, makers 357, micro 1,457) |
| forums | 95 + 105 world spaces (ids 10,095 .. 10,199) |
| submissions | 127,391 + 854 world posts (ids 137,403 ..) |
| comments | 2,551,513 + 4,331 world comments (ids 2,561,513 ..; 18 removed by moderators) |
| scheduled_events | 321 (world posts/comments after `social_now`, fired as the clock moves) |
| space_rules / flairs | 952 / 1,187 (every forum) |
| moderators | 130 (1-2 most active world users per new space) |
| forum_subscriptions | 8,482 (world users: the spaces they post in + interests) |
| notifications | 4,331 (replies to world users; older ones mostly read) |
| forum_log_entries | 37 (comment removals, thread locks in new spaces) |
| posting_limits | 29 |

| Network (w1) | Rows |
|---|---|
| devblog | 78 articles (26 tags), 282 comments, 28 scheduled; 7,091 follows, 1,428 tag follows, 1,365 reactions, 194 reading-list saves, 787 notifications |
| makers | 49 posts in 8 groups + the main feed, 204 comments, 16 scheduled; 110 products, 114 milestones; 4,302 follows, 822 upvotes, 540 notifications |
| micro | 4,210 posts + 4,330 replies, 502 scheduled; 48,264 follows, 22,176 likes, 2,357 reposts, 11,103 notifications |
| world_affiliations | 2,246 |

Size: 1.28 GB with every network (forum 1.28 GB).

## Time

The site clock starts at `2026-10-14 18:00:00` UTC (`site_settings.social_now`, the world's last
day; `WSB_SOCIAL_CLOCK` overrides). Rows dated after the tenant clock are not shown. World items
after it are `scheduled_events`: every request fires the due ones (in `fire_at`, `id` order), and
a kit job queued for the next one fires them when `/__rl/clock {advance}` moves time, so replies
and notifications arrive while a rollout runs; a reset un-fires them.

## Passwords

WebArena users: `test1234` (forum). World users: `Password.123`. Rollouts use `POST /__rl/login`.
