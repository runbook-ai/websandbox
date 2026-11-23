'use strict';
// Code site widget slots (docs/WIDGETS.md). Off (no scenario) = the pages are unchanged.
//   issues      issue and merge request lists (project, group, dashboard): the next 500 items from
//               the current page as one list (LIST_KINDS)
//   commits     commit history: the next 400 commits from the current page as one list (LIST_KINDS;
//               a day heading goes with the first commit of each day)
//   discussion  older: the activity of an issue / merge request opens at its newest 10 entries in a
//               box; scrolling up loads older ones, 10 at a time
//   editor      issue description, comment, reply and comment-edit fields (shadow | contenteditable)
//   counts      js: the per-state counts of issue / merge request lists (and the "Showing .. of N"
//               total) come only from an API call that a script makes; the project sidebar shows no
//               open-issue / open-MR count badges
const kit = require('../../../kit');
const W = kit.widgets;

const SLOTS = { issues: W.LIST_KINDS, commits: W.LIST_KINDS, discussion: ['older'], editor: W.EDITOR_KINDS, counts: ['js'] };
const ISSUES_WINDOW = 500;
const COMMITS_WINDOW = 400;
const DISCUSSION_STEP = 10;

function locals() {
  const ed = kit.widget('editor');
  // counts js: the project sidebar's open-issue / open-MR badges are left out (the list tabs carry the counts)
  return { edAttr: ed ? ` data-wsb-editor="${ed}"` : '', wScripts: ed ? W.script('editor') : '', wCounts: kit.widget('counts') === 'js' };
}

module.exports = { SLOTS, ISSUES_WINDOW, COMMITS_WINDOW, DISCUSSION_STEP, locals };
