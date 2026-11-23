# Makers routes ("Workbench", network 3 of the social DB)

Accounts are this network's handles: `/<handle>`. Posts are `/post/<slug>-<id>` (wrong slugs
redirect; the grader compares `/post/-<id>`), groups `/group/<slug>` (forums of network 3 named
`makers_<slug>`), products `/product/<slug>`. Log in at `/login` (handle, username or email; world
users `Password.123`). Forms post with `_csrf`; the page script sends the same forms with
`Accept: application/json`. Upvotes are `reactions` of kind `upvote`.

| Route | What |
|---|---|
| `GET /`, `/newest`, `/top/<week\|month\|year\|all>` | post feed: popular (newer first, lifted by upvotes and comments), newest, most upvoted; groups on the left, top products by revenue and recent milestones on the right; `?page=`, `?fragment=1` = rows only ("Load more") |
| `GET /groups` | groups with members / posts and Join |
| `GET /group/<slug>`, `/group/<slug>/newest`, `/group/<slug>/top/<window>` | a group's feed, Join / Joined |
| `POST /group/<slug>/join` | `action` = `join` \| `leave`; JSON `{joined, members}` |
| `GET /post/<slug>-<id>` | post with upvote tile, group, product, author card with Follow, comments (`?sort=top\|latest\|oldest`, `?reply=<comment id>`); author: `?edit=1` |
| `POST /post/<slug>-<id>/comments` | `body` (markdown), `parent_id`; 429 over 10 comments in 10 minutes |
| `POST /post/<slug>-<id>/edit`, `.../delete` | author (`body`) |
| `POST /comments/<id>/edit`, `/comments/<id>/delete` | own comments |
| `GET /new` (`?group=`, `?product=`), `POST /new` | `title` (150), `body` (markdown), `group` (slug, optional), `product` (slug of one of your own products, optional). 422 field errors; 429 "at most twice a day" |
| `POST /upvote` | `target` = `post` \| `comment`, `id`, `on` (omit = toggle); JSON `{upvoted, upvotes}`; 403 on your own post; notifies |
| `GET /products` | `sort` = `revenue` \| `newest` \| `name`, `q`, `topic`; totals |
| `GET /product/<slug>` | name, tagline, category, launch date, monthly revenue and rank, founder (Follow), about, milestone timeline, posts about it |
| `POST /product/<slug>/milestones` | founder only: `title`, `value` (e.g. "250 users"), `mrr` (new monthly revenue, whole dollars; updates the product) |
| `GET /<handle>`, `/<handle>/comments`, `/<handle>/followers`, `/<handle>/following` | profile: posts, upvotes received, products, groups |
| `POST /follow` | `handle`, `on`; JSON `{following, followers}` |
| `GET /notifications` (`?filter=unread`) | `POST /notifications/read` `id` (+ `go`) or `all=1` |
| `GET /search?q=` | `type` = `posts` \| `products` \| `people` |
| `GET /login`, `POST /login`, `POST /logout` | |
