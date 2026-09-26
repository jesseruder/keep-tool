// Shared by the console and the UI worker: where text names a Keep session by its
// number (`#453`). The console links what this finds (web/app/terminal-refs.js), and
// the worker counts the same thing as a mention (bin/terminal-ref-lookup.js,
// bin/session-text-search.js), so a hover card never lists a "mention" the terminal
// would not have linked.
(function (root) {
  'use strict';

  // `#` then digits, standing alone: not `repo#12`, `&#39;`, `a/#3` or `##4`, and not
  // a hex colour or anchor like `#123abc` or `#12-top`. A GitHub reference reads the
  // same, so a number right after PR/issue/pull request/MR (`PR #12`, `PR: #12`,
  // `issue (#12)`) is left alone, and so is an all-digit colour after
  // color/fill/background (`color: #123456`).
  const REF = /#(\d{1,6})(?![\w-])/g;
  const NOT_SESSION = /(?:\b(?:prs?|pull(?:\s+requests?)?|pulls|issues?|mrs?|bugs?|tickets?|colou?r|fill|stroke|background|bg)[\s:=("'`]*$|[\w#&/=]$)/i;

  function findSessionMentions(text) {
    const source = String(text || '');
    const found = [];
    for (const match of source.matchAll(REF)) {
      if (NOT_SESSION.test(source.slice(Math.max(0, match.index - 24), match.index))) continue;
      const num = Number(match[1]);
      if (num >= 1) found.push({ num, start: match.index, end: match.index + match[0].length });
    }
    return found;
  }

  // The first place `text` mentions session `num`, or -1.
  function mentionIndex(text, num) {
    const hit = findSessionMentions(text).find((mention) => mention.num === Number(num));
    return hit ? hit.start : -1;
  }

  const api = { findSessionMentions, mentionIndex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.KeepSessionMentions = api;
})(globalThis);
