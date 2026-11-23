'use strict';
// Which generated templates touch which widget slot (docs/WIDGETS.md), per site. Conservative: a
// template is listed under a slot only when the pages its tasks are solved on contain that slot's
// widget (the list / box / editor / frame / grid the slot changes). Used by gen.js (variant tasks)
// and ui-check.js.
//   slot -> { values, abbr, templates: [...] }   (template names without the gen-<site>- prefix)
const FORUM_LIST = ['unmount', 'recycle', 'pinned', 'sections', 'grid', 'infinite'];

const COMMENT_PAGES = ['top-comment-author', 'top-level-count', 'parent-comment-author', 'thread-user-comment-count', 'search-comment-phrase',
  'upvote-top-comment', 'downvote-user-comments', 'mod-remove-lowest-comment', 'delete-own-comment', 'edit-own-comment'];
const LISTING_PAGES = ['top-post-author', 'most-commented-title', 'nth-top-score', 'newest-post-comments', 'most-active-title', 'top-link-domain', 'nth-newest-title',
  'mod-lock-post', 'mod-pin-post', 'mod-ban-author', 'mod-add-moderator', 'message-post-author', 'crosspost-top-link', 'reply-quoting-title'];

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
};

// short codes for variant ids: <slot>-<value>
const SLOT_ABBR = { comments: 'cm', listing: 'ls', editor: 'ed', links: 'lk', plant: 'pl', grid: 'gr', reviews: 'rv', card: 'cd', price: 'pr', checkout: 'co',
  admin_grid: 'ag', admin_job: 'aj', inbox: 'ib', thread: 'th', issues: 'is', commits: 'cs', discussion: 'ds', counts: 'ct' };
const VALUE_ABBR = { unmount: 'un', recycle: 'rc', pinned: 'pn', sections: 'sc', grid: 'gd', infinite: 'in', shadow: 'sh', contenteditable: 'ce', js: 'js',
  'frame-same': 'fs', 'frame-cross': 'fx', slow: 'sl', older: 'ol', reply: 'rp', message: 'ms', post: 'po', answer: 'an', review: 'rw', contact: 'ct', send: 'sd', forward: 'fw' };
const code = (slot, value) => `${SLOT_ABBR[slot]}-${VALUE_ABBR[value]}`;

// The widget kind held out of training on every site (variants using it go to the held-out split).
const HELDOUT = { value: 'sections' };

module.exports = { SITES, SLOT_ABBR, VALUE_ABBR, code, HELDOUT };
