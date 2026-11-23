# Micro routes ("Murmur", network 4 of the social DB)

Accounts are this network's handles: `/<handle>`; posts `/<handle>/status/<id>` (a wrong handle
redirects). Posts and replies are both `submissions` (`kind` `short` / `reply`; replies carry
`reply_to` and `root_id`, quotes `quote_of`). Log in at `/login` with the handle (with or
without `@`), username or email; world users `Password.123`. Forms post with `_csrf`; the page
script sends the same forms with `Accept: application/json`.

| Route | What |
|---|---|
| `GET /` | `/home` when signed in, else `/explore` |
| `GET /home`, `/home/following` | "For you" (the last two days ranked by likes, replies, reposts) and "Following" (followed accounts' posts and reposts, newest first); composer on top; `?text=` prefills it. Infinite, virtualized timeline (`?page=`, `?fragment=1` = posts only) |
| `GET /explore` | popular posts, search box |
| `GET /search?q=` | `f` = `top` \| `live` \| `user`; `from:<handle>` narrows to one account; `#tag` links search the tag |
| `GET /<handle>`, `/<handle>/with_replies`, `/<handle>/likes` | profile: banner, bio, joined, following / followers counts, Follow, Message; posts (+ reposts), posts and replies, liked posts |
| `GET /<handle>/followers`, `/<handle>/following` | people lists with Follow buttons |
| `GET /<handle>/status/<id>` | the post with its parent chain above, stats (reposts, likes, replies), "Liked by", reply box, replies |
| `GET /compose` (`?reply_to=`, `?quote=`, `?text=`) | no-JS composer page (the page script opens a dialog instead) |
| `POST /compose` | `text` (at most 280 characters, counted as code points), `reply_to`, `quote_of`. 422 empty / over the limit, 404 deleted target, 429 over the hourly limit (50 posts; replies: 50 replies) with `Retry-After`. Notifies the replied-to author (`reply`), the quoted author (`quote`) and @mentions (`mention`) |
| `POST /i/like`, `/i/repost`, `/i/bookmark` | `id`, `on` = `1` \| `0` (omit = toggle); JSON `{liked, likes}`, `{reposted, reposts}`, `{bookmarked}`; likes and reposts notify |
| `POST /i/follow` | `handle`, `on`; JSON `{following, followers}` |
| `POST /i/delete` | `id` (own post) |
| `GET /i/bookmarks` | bookmarked posts |
| `GET /notifications`, `/notifications/mentions` | all (likes, reposts, follows, replies, quotes, mentions) / mentions, replies and quotes; `POST /notifications/read` `id` or `all=1` |
| `GET /messages`, `/messages/<thread>`, `/messages/compose?to=` | direct messages (`message_threads.network_id` = 4) |
| `POST /messages` | `to` (handle), `text`: one conversation per pair; notifies (`message`) |
| `POST /messages/<thread>` | `text` |
| `GET /login`, `POST /login`, `POST /logout` | |

Page features: icon navigation with unread badges, a `<dialog>` composer with a character counter,
`<details>` repost / quote and post menus, clickable timeline cells, copy-link, a timeline that
loads more as you scroll and parks far-away cells as fixed-height placeholders (virtualized).
