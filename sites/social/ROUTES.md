# Social routes (frontend "community")

Spaces are `c/<name>` (case-insensitive), users `u/<name>`. Things are `t3_<post id>` and
`t1_<comment id>` (element ids and vote targets). Pages that change state need a login
(`/login`; WebArena users `test1234`, world users `Password.123`); forms post with `_csrf`, and
the page script sends the same forms with `fetch` (`Accept: application/json`).

| Route | What |
|---|---|
| `GET /`, `/new`, `/top`, `/rising` | home feed: joined spaces (or every space when none / signed out); `?t=hour\|day\|week\|month\|year\|all` for top; `?page=` (the feed loads the next page as you scroll) |
| `GET /all`, `/all/<sort>` | every community post |
| `GET /c/<space>`, `/c/<space>/<sort>` | space feed (pinned posts first); `?flair=<id>` filter; banner with Join; sidebar: about, members, rules, flair, moderators |
| `GET /communities` (`?q=`) | community directory, by members |
| `GET /c/<space>/comments/<id>/<slug>` | post page, nested comments (`?sort=best\|top\|new\|old\|controversial`; deeper than 8 levels: "Continue this thread"); `?reply=<comment id>` opens a reply form without JS; `?edit=1` (author) edits the body. A wrong space name or slug redirects to the canonical URL |
| `GET /c/<space>/comments/<id>/<slug>/<comment id>` | one comment's thread |
| `POST /c/<space>/comments/<id>/<slug>/comment` | `body` (markdown), `parent_id` (reply); 403 locked / removed, 429 posting too fast |
| `POST .../<comment id>/edit`, `.../<comment id>/delete` | own comment (delete = `[deleted]`); moderators delete = remove (logged) |
| `POST .../<slug>/edit`, `.../<slug>/delete` | own post |
| `POST .../<slug>/mod` | moderators: `action` = `remove` (`reason`) \| `approve` \| `lock` \| `unlock` \| `pin` \| `unpin` |
| `GET /submit` (`?space=`, `?type=link`), `/c/<space>/submit` | create a post: community picker (combobox), Text / Link tabs, title (300 chars), rich text editor, flair dialog, the space's rules beside it |
| `POST /submit` | `space`, `type` = `text` \| `link`, `title`, `body`, `url`, `flair_id`. 422 with field errors or a rules banner (enforced rule kinds, SCHEMA.md); 429 "You're posting too fast" (`posting_limits`, `Retry-After`) |
| `POST /vote` | `thing` = `t3_<id>` \| `t1_<id>`, `dir` = `1` \| `-1` \| `0`; JSON `{score, dir}` |
| `POST /save` | `thing` = `t3_<id>`, `saved` = `1` \| `0` |
| `POST /c/<space>/join` | `action` = `join` \| `leave` |
| `POST /u/<name>/follow` | `action` = `follow` \| `unfollow` (notifies) |
| `GET /u/<name>`, `/u/<name>/posts`, `/u/<name>/comments`, `/u/<name>/saved` (own) | profile: karma, cake day, followers, moderator of |
| `GET /notifications` (`?filter=unread`) | replies, mentions, follows; `POST /notifications/read` `id` (+ `go` = where to go next) or `all=1` |
| `GET /inbox`, `/inbox/<thread>`, `POST /inbox/<thread>/reply` | private messages |
| `GET /message/compose` (`?to=&subject=`), `POST /message/compose` | `to` (username), `subject`, `body` |
| `GET /search?q=` | `type` = `posts` \| `comments` \| `communities` \| `people`, `sort` = `relevance` \| `new` \| `top`, `t`; `/c/<space>/search?q=` searches one space |
| `GET /api/spaces?q=`, `/api/spaces/<space>/flairs`, `/api/users/<name>/card` | JSON for the picker, flair dialog and user hover cards |
| `GET /login`, `POST /login`, `POST /logout` | |

Page features an agent meets: a sticky header with scoped search, a left nav with joined spaces,
custom elements (`post-card`, `vote-bar`, `comment-node`, `rich-editor`, `notification-item`),
a contenteditable editor with a toolbar and a "Markdown mode" switch, a `<dialog>` flair picker,
infinite scroll, hover cards on user links, collapsible comment threads, `<details>` menus, and a
"log in" sheet at the bottom of post pages for signed-out visitors.
