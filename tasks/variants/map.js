'use strict';
// Which generated templates touch which widget slot (docs/WIDGETS.md), per site. Conservative: a
// template is listed under a slot only when the pages its tasks are solved on contain that slot's
// widget (the list / box / editor / frame / grid the slot changes). Used by gen.js (variant tasks)
// and ui-check.js.
//   slot -> { values, templates: [...], late?, filter? }   (template names without the gen-<site>- prefix;
//   late: drawn after every site's other slots; filter(task): which base tasks fit)
const FORUM_LIST = ['unmount', 'recycle', 'pinned', 'sections', 'grid', 'infinite'];

const COMMENT_PAGES = ['top-comment-author', 'top-level-count', 'parent-comment-author', 'thread-user-comment-count', 'search-comment-phrase',
  'upvote-top-comment', 'downvote-user-comments', 'mod-remove-lowest-comment', 'delete-own-comment', 'edit-own-comment'];
const LISTING_PAGES = ['top-post-author', 'most-commented-title', 'nth-top-score', 'newest-post-comments', 'most-active-title', 'top-link-domain', 'nth-newest-title',
  'mod-lock-post', 'mod-pin-post', 'mod-ban-author', 'mod-add-moderator', 'message-post-author', 'crosspost-top-link', 'reply-quoting-title'];

// community (social): space feeds, and post pages with comment threads
const SOCIAL_FEED = ['top-flair-post-week', 'save-top-flair', 'mod-lock-pin-top', 'mod-remove-title-rule', 'reply-newest-unanswered'];
const SOCIAL_COMMENTS = ['comments-by-user-on-post', 'upvote-user-comments', 'reply-unread-replies', 'follow-commenters', 'reply-and-dm-op'];
// private messages (community) / direct messages (micro): templates whose pages are a conversation
const SOCIAL_DM_WRITE = ['dm-reply-unread', 'dm-send-post-link', 'dm-notify-meet', 'dm-answer-topic'];
const SOCIAL_DM_THREAD = ['dm-meet-when', 'dm-borrow-item', 'dm-work-deadline', 'dm-thread-length', ...SOCIAL_DM_WRITE];
const MICRO_DM_WRITE = ['dm-reply-unread', 'dm-send-post-link', 'dm-answer-topic'];
// a load-older box only appears on conversations with more than 5 messages (the task's `changes` say how many)
const longThread = (t) => (t.changes || []).some((c) => { const m = /^thread \d+ \((\d+) messages\)/.exec(c); return m && +m[1] > 5; });

const SITES = {
  forum: {
    files: ['tasks/forum/generated.jsonl'], prefix: 'gen-forum-',
    slots: {
      comments: { values: FORUM_LIST, templates: COMMENT_PAGES },
      listing: { values: FORUM_LIST, templates: LISTING_PAGES },
      editor: { values: ['shadow', 'contenteditable'], templates: ['reply-user-latest-comment', 'edit-own-comment', 'reply-quoting-title', 'create-text-post', 'create-link-post', 'create-forum-with-post', 'crosspost-top-link'] },
      links: { values: ['js'], templates: [...COMMENT_PAGES, ...LISTING_PAGES] },
      plant: { values: ['reply', 'message', 'post', 'answer'], templates: [...COMMENT_PAGES, 'reply-user-latest-comment', 'reply-quoting-title', 'newest-post-comments'] },
    },
  },
  store: {
    files: ['tasks/store/generated-shopping.jsonl', 'tasks/store/generated-admin.jsonl'], prefix: /^gen-(shopping|admin)-/,
    slots: {
      grid: { values: ['grid', 'infinite', 'unmount', 'sections'], templates: ['brand-count', 'price-band-count', 'brand-price-extreme', 'search-sorted-nth', 'luma-color-size-count', 'search-add-cheapest', 'wishlist-most-reviewed', 'buy-cheapest-rated'] },
      reviews: { values: FORUM_LIST, templates: ['review-histogram', 'rating-summary'] },
      card: { values: ['shadow'], templates: ['brand-count', 'price-band-count', 'brand-price-extreme', 'search-sorted-nth', 'luma-color-size-count', 'review-histogram', 'rating-summary', 'product-spec', 'variant-options', 'cart-add-options', 'cart-add-variant', 'search-add-cheapest', 'compare-pair'] },
      price: { values: ['js'], templates: ['brand-price-extreme', 'search-sorted-nth', 'price-band-count', 'search-add-cheapest', 'buy-cheapest-rated', 'product-spec'] },
      checkout: { values: ['frame-same', 'frame-cross'], templates: ['checkout-new-address', 'buy-cheapest-rated'] },
      admin_grid: { values: [...FORUM_LIST, 'shadow'], templates: ['product-grid-count', 'orders-status-daterange', 'customer-lookup', 'customer-field', 'customer-order-count', 'customer-biggest-order', 'order-view-field', 'mass-price-adjust', 'mass-disable-brand', 'customer-group', 'customer-dob-gender'] },
      admin_job: { values: ['slow'], templates: ['bestseller-units', 'orders-report-month', 'top-customer-period'] },
      editor: { values: ['shadow', 'contenteditable'], templates: ['review-ordered-item'] },
      // the plant sits in a review: only templates whose product page has reviews
      plant: { values: ['review', 'contact', 'answer'], templates: ['review-histogram', 'rating-summary', 'review-ordered-item'] },
    },
  },
  mail: {
    files: ['tasks/mail/generated.jsonl'], prefix: 'gen-mail-',
    slots: {
      inbox: { values: FORUM_LIST, templates: ['unread-count-from', 'latest-subject-from', 'newsletter-count', 'exchanged-count', 'label-conversations', 'archive-newsletter', 'star-unread-from', 'label-conversation'] },
      thread: { values: ['older'], templates: ['vendor-quote-amount', 'colleague-request-when', 'friend-plan-day', 'campaign-accepted', 'campaign-personal-replies', 'campaign-bounced-who', 'reply-in-thread', 'forward-quote', 'resend-bounced', 'remove-unsubscribed-contacts'] },
      editor: { values: ['shadow', 'contenteditable'], templates: ['reply-in-thread', 'send-new-to-contact', 'forward-quote', 'campaign-follow-up', 'resend-bounced'] },
      plant: { values: ['send', 'forward', 'answer'], templates: ['vendor-quote-amount', 'colleague-request-when', 'friend-plan-day', 'campaign-accepted', 'campaign-personal-replies', 'campaign-bounced-who', 'reply-in-thread', 'forward-quote'] },
    },
  },
  code: {
    files: ['tasks/code/generated.jsonl'], prefix: 'gen-code-',
    slots: {
      issues: { values: FORUM_LIST, templates: ['issue-filter-count', 'issue-most-comments', 'mr-reviewer-count', 'reopen-latest-closed', 'assign-most-commented', 'issue-detail', 'mr-branches', 'mr-request-review', 'close-issue-comment'] },
      commits: { values: FORUM_LIST, templates: ['branch-latest-commit', 'path-history', 'author-commit', 'commit-stats', 'default-branch-head'] },
      discussion: { values: ['older'], templates: ['close-issue-comment', 'reopen-latest-closed', 'issue-relabel', 'issue-milestone-due', 'assign-most-commented'] },
      editor: { values: ['shadow', 'contenteditable'], templates: ['create-issue-full', 'close-issue-comment'] },
      counts: { values: ['js'], templates: ['issue-filter-count', 'mr-reviewer-count'] },
    },
  },
  // the social frontends (sites/social = community, devblog, micro, makers); appended last, so the
  // earlier sites' seeded draws are unchanged
  social: {
    files: ['tasks/social/generated.jsonl'], prefix: 'gen-social-',
    slots: {
      feed: { values: FORUM_LIST, templates: SOCIAL_FEED },
      comments: { values: FORUM_LIST, templates: SOCIAL_COMMENTS },
      editor: { values: ['shadow', 'contenteditable'], templates: ['reply-newest-unanswered', 'post-with-flair', 'no-self-promo-post', 'reply-unread-replies', 'reply-and-dm-op', 'edit-post-update'] },
      links: { values: ['js'], templates: [...SOCIAL_FEED.filter((x) => x !== 'reply-newest-unanswered'), 'comments-by-user-on-post', 'upvote-user-comments', 'top-space-of-user', 'oldest-comment-phrase'] },
      plant: { values: ['reply', 'message', 'post', 'answer'], templates: SOCIAL_COMMENTS },
      // private conversations (late: drawn after every site's other slots, so those stay as they were)
      messages: { values: ['older'], templates: SOCIAL_DM_THREAD, late: true, filter: longThread },
      msg_editor: { values: ['shadow', 'contenteditable'], templates: [...SOCIAL_DM_WRITE, 'message-mods', 'reply-and-dm-op'], late: true },
    },
  },
  devblog: {
    files: ['tasks/devblog/generated.jsonl'], prefix: 'gen-devblog-',
    slots: {
      feed: { values: FORUM_LIST, templates: ['top-tag-article', 'follow-top-tag-author', 'save-latest-article', 'author-tag-count'] },
      comments: { values: FORUM_LIST, templates: ['top-follower-commenter', 'reply-to-comment'] },
      editor: { values: ['shadow', 'contenteditable'], templates: ['publish-article', 'save-draft', 'reply-to-comment', 'edit-add-tag', 'publish-limit'] },
      readinglist: { values: FORUM_LIST, templates: ['readinglist-tag-count'] },
      plant: { values: ['comment', 'publish', 'answer'], templates: ['top-follower-commenter', 'reply-to-comment', 'react-kind', 'series-part'] },
      reactions: { values: ['js'], templates: ['top-tag-article', 'my-top-article', 'follow-top-tag-author', 'react-kind'] },
    },
  },
  micro: {
    files: ['tasks/micro/generated.jsonl'], prefix: 'gen-micro-',
    slots: {
      timeline: { values: FORUM_LIST, templates: ['hashtag-count-by', 'like-recent-posts', 'bookmark-newest', 'delete-post-containing', 'follow-repliers'] },
      thread: { values: ['older'], templates: ['reply-newest-mention', 'thread-reply-count'] },
      composer: { values: ['shadow', 'contenteditable'], templates: ['post-hashtag', 'reply-newest-mention', 'quote-post'] },
      plant: { values: ['reply', 'dm', 'post', 'answer'], templates: ['who-liked', 'thread-reply-count', 'reply-newest-mention', 'quote-post', 'like-recent-posts', 'bookmark-newest', 'follow-repliers', 'hashtag-count-by', 'delete-post-containing', 'reposters-of-mine'] },
      counts: { values: ['js'], templates: ['who-liked', 'reposters-of-mine', 'like-recent-posts'] },
      // direct-message conversations (late, like the community's)
      dm: { values: ['older'], templates: ['dm-thread-length', 'dm-meet-when', ...MICRO_DM_WRITE], late: true, filter: longThread },
      dm_composer: { values: ['shadow', 'contenteditable'], templates: [...MICRO_DM_WRITE, 'dm-user'], late: true },
    },
  },
  makers: {
    files: ['tasks/makers/generated.jsonl'], prefix: 'gen-makers-',
    slots: {
      feed: { values: FORUM_LIST, templates: ['top-upvoted-post', 'top-mrr-in-group', 'upvote-user-posts'] },
      comments: { values: FORUM_LIST, templates: ['answer-question-post', 'post-product-revenue'] },
      editor: { values: ['shadow', 'contenteditable'], templates: ['post-group-product', 'no-self-promo-post', 'answer-question-post'] },
      product: { values: ['shadow', 'js'], templates: ['latest-milestone', 'mrr-gap', 'post-product-revenue', 'top-product-topic', 'top-mrr-in-group', 'follow-top-founder', 'update-revenue'] },
      plant: { values: ['comment', 'post', 'answer'], templates: ['answer-question-post', 'post-product-revenue'] },
    },
  },
};

// short codes for variant ids: <slot>-<value>
const SLOT_ABBR = { comments: 'cm', listing: 'ls', editor: 'ed', links: 'lk', plant: 'pl', grid: 'gr', reviews: 'rv', card: 'cd', price: 'pr', checkout: 'co',
  admin_grid: 'ag', admin_job: 'aj', inbox: 'ib', thread: 'th', issues: 'is', commits: 'cs', discussion: 'ds', counts: 'ct',
  feed: 'fd', messages: 'mg', readinglist: 'rl', reactions: 'rx', timeline: 'tl', composer: 'cp', dm: 'dm', product: 'pd', msg_editor: 'me', dm_composer: 'dc' };
const VALUE_ABBR = { unmount: 'un', recycle: 'rc', pinned: 'pn', sections: 'sc', grid: 'gd', infinite: 'in', shadow: 'sh', contenteditable: 'ce', js: 'js',
  'frame-same': 'fs', 'frame-cross': 'fx', slow: 'sl', older: 'ol', reply: 'rp', message: 'ms', post: 'po', answer: 'an', review: 'rw', contact: 'ct', send: 'sd', forward: 'fw',
  comment: 'cm', publish: 'pb', dm: 'dm' };
const code = (slot, value) => `${SLOT_ABBR[slot]}-${VALUE_ABBR[value]}`;

// The widget kind held out of training on every site (variants using it go to the held-out split).
const HELDOUT = { value: 'sections' };

module.exports = { SITES, SLOT_ABBR, VALUE_ABBR, code, HELDOUT };
