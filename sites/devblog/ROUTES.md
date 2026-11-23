# Devblog routes ("Byteline", network 2 of the social DB)

Accounts are this network's handles (`accounts.handle`, case-insensitive): `/<handle>`. Articles
are `/<handle>/<slug>-<id>` (a wrong handle or slug redirects to the canonical URL; the grader
compares `/<handle>/-<id>`). Pages that change state need a login (`/login` with the handle,
username or email; world users `Password.123`); forms post with `_csrf`, and the page script sends
the same forms with `fetch` (`Accept: application/json`). A user without a devblog account gets one
(handle = username) the first time they act.

| Route | What |
|---|---|
| `GET /` | home feed, "Relevant": followed authors and tags when there are enough of them (else everything), hot over the last 30 days; `?page=` (the feed loads the next page as you scroll; `?fragment=1` = cards only) |
| `GET /latest`, `/top/<week\|month\|year\|infinity>` | newest articles; most reactions in the window |
| `GET /tags` (`?q=`) | tag directory with Follow buttons |
| `GET /t/<tag>`, `/t/<tag>/latest`, `/t/<tag>/top/<window>` | tag page: description, post and follower counts, Follow |
| `POST /t/<tag>/follow` | `on` = `1` \| `0` (omit = toggle); JSON `{following, followers}` |
| `GET /<handle>` | profile: bio, joined, followers, posts / comments / tags counts, series, recent comments, articles |
| `GET /<handle>/<slug>-<id>` | article: reaction rail (like, unicorn, insightful, funny, fire, save), tags, series box, author card with Follow, "More from", comments (`?sort=top\|latest\|oldest`, `?reply=<comment id>` opens a reply box without JS) |
| `POST /<handle>/<slug>-<id>/comments` | `body` (markdown), `parent_id`; 429 over the comment limit (10 in 10 minutes) |
| `POST /comments/<id>/edit`, `/comments/<id>/delete` | own comments (`body`) |
| `GET /<handle>/series/<id>` | a series' parts in order |
| `GET /new` (`?title=`, `?tags=`), `POST /new` | editor: `title` (128), `tags` (comma separated, at most 4; new tags are created), `body` (markdown, Edit / Preview tabs, toolbar), `series_id` or `new_series`, `action` = `publish` \| `draft`. 422 with field errors; 429 "at most 5 articles per day" (published articles only) |
| `GET /<handle>/<slug>-<id>/edit`, `POST .../edit` | author: same fields; publishing a draft counts against the limit; a published article keeps its URL |
| `POST /<handle>/<slug>-<id>/delete` | author |
| `POST /api/preview` | `body` -> `{html}` (the editor's Preview tab) |
| `POST /reactions` | `target` = `article` \| `comment`, `id`, `kind` (comments: `like`), `on` = `1` \| `0` (omit = toggle); JSON `{on, count, total, kind}`; notifies the author |
| `POST /readinglist` | `id`, `on`; JSON `{saved, count}` |
| `POST /follow` | `handle`, `on`; JSON `{following, followers}`; notifies |
| `GET /readinglist` (`?q=`, `?tag=`) | saved articles, filter by title or tag |
| `GET /dashboard` (`?filter=all\|published\|draft`) | own posts with reactions / comments / saves, totals; Edit, Delete |
| `GET /dashboard/followers`, `/dashboard/following`, `/dashboard/tags` | people and followed tags |
| `GET /notifications`, `/notifications/<comments\|reactions\|follows>` | `POST /notifications/read` `id` (+ `go`) or `all=1` |
| `GET /settings`, `POST /settings` | `display_name` (50), `bio` (200) |
| `GET /search?q=` | `filter` = `posts` \| `people` \| `tags` \| `comments`, `sort` = `relevant` \| `newest` |
| `GET /login`, `POST /login`, `POST /logout` | |

Page features: a sticky header with search and an avatar menu, a left nav with followed tags, a
right "Trending this week" column, sticky reaction rail, `<details>` reply boxes and menus, an
editor with Edit / Preview tabs and a markdown toolbar, infinite scroll on feeds.
