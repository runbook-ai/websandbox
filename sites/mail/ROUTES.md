# Mail routes

Every mailbox page needs a login (`/login`, username = local part of the address, or any of the user's
addresses; password `Password.123`; rollouts use `POST /__rl/login {"user": ...}`). All queries are
scoped to the signed-in user.

| Route | What |
|---|---|
| `GET /` | redirect to `/mail/inbox` (or `/login`) |
| `GET /mail/:folder` | thread list; folders `inbox` (`?category=primary\|social\|promotions\|updates`, default primary), `starred`, `important`, `sent`, `drafts`, `all`, `spam`, `trash`; `?page=` |
| `GET /label/:name` | threads with a user label |
| `GET /search?q=` | search with operators: `from:` `to:` `cc:` `subject:` `label:` `is:unread\|read\|starred\|important` `in:inbox\|sent\|drafts\|spam\|trash\|anywhere` `has:attachment` `filename:` `category:` `before:`/`after:` (`YYYY/MM/DD`) `older_than:`/`newer_than:` (`7d`, `2m`, `1y`), `"phrase"`, `-word`; default scope excludes spam, trash, drafts |
| `POST /threads/action` | `ids` (thread ids, repeatable), `action` = `archive` `inbox` `trash` `untrash` `spam` `notspam` `read` `unread` `star` `unstar` `important` `unimportant` `label:<id>` `unlabel:<id>` `delete` (forever, trash only); `return` = URL to go back to |
| `GET /thread/:id` | conversation (marks it read); `?from=` back link |
| `POST /message/:id/star` | toggle a message's star |
| `GET /compose` | new message; `?to=&subject=&body=`, `?reply=<message id>[&all=1]`, `?forward=<message id>`, `?draft=<message id>` |
| `POST /compose` | `action` = `send` \| `draft` \| `discard`; `from` (one of the user's addresses), `to`, `cc`, `bcc` (comma-separated, `Name <addr>` or `addr`), `subject`, `body`, `inReplyTo`, `threadId`, `draftId` |
| `GET /contacts` (`?q=`), `GET /contacts/new`, `POST /contacts`, `GET /contacts/:id`, `POST /contacts/:id`, `POST /contacts/:id/delete` | contacts |
| `GET /api/contacts?q=` | recipient autocomplete (JSON) |
| `GET /settings`, `POST /settings` | name, page size, signature, vacation responder (`vacation_on`, `vacation_subject`, `vacation_body`) |
| `GET /settings/labels`, `POST /settings/labels` (`name`, `color`), `POST /settings/labels/:id` (`name` or `action=delete`) | labels |
| `GET /settings/filters`, `POST /settings/filters`, `POST /settings/filters/:id/delete` | filters: `match_from`, `match_to`, `match_subject`, `match_words` -> `add_label_id`, `skip_inbox`, `mark_read`, `star`, `trash`; `apply_existing` |

## Delivery

- Mail to an address of a user on the site is delivered at once into their inbox (threaded by
  `In-Reply-To`), their filters run, and if their vacation responder is on a reply is queued (60 s of
  site time).
- Mail to an unknown address at a domain the site knows (`inboxmail.example`, any domain seen in mail)
  or to a malformed address bounces: a "Delivery Status Notification (Failure)" from
  `mailer-daemon@inboxmail.example` arrives in the sender's inbox after 45 s of site time.
- Addresses with `addresses.delivery = 'autoreply'` answer with their out-of-office text after 90 s.
- Any other external address is accepted silently.

Rollouts advance time with `POST /__rl/clock {"advance": 120}`, which also runs the due jobs.
