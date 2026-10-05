'use strict';

// /approve and /deny in an owner-decision issue (approval workflow, issue_comment: created).
// The repository is PUBLIC, so anyone can comment. A comment counts ONLY if ALL of these hold:
//   a) the commenter is on the approver allowlist (config/protection.json, protected) AND their
//      author_association is OWNER;
//   b) the issue was opened by the clubOrchestra workflow bot, carries exactly one hidden marker
//      with the approval id, and is the issue our outbox recorded for that id. The approval id is
//      read from the bot's marker, NEVER from the comment;
//   c) the approval is still pending (otherwise: no change; the owner gets "already decided");
//   d) the comment's first line is exactly `/approve` or `/deny` (an optional reason may follow on
//      the same line or below). A quote (`>`), an indented or fenced code block, or anything before
//      the command does not count;
//   e) the event is `created` (edits are ignored).
// Everything else is ignored and audit-logged, with no reply (strangers get no feedback that would
// help them guess the rules). The comment text is stored only as data (decision_reason) and is never
// passed to the planner or worker, nor to a shell.
const { isPlainObject } = require('./events');

const BOT_LOGINS = Object.freeze(['github-actions[bot]']);
const MARKER_RE = /<!-- clubOrchestra:approval_id=([A-Za-z0-9._-]{1,120}) -->/g;
const COMMAND_RE = /^\/(approve|deny)(?:[ \t]+(\S[^\n]*))?$/;

function parseCommand(body) {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const first = lines[0].replace(/[ \t]+$/, '');
  const m = COMMAND_RE.exec(first);
  if (!m) return null;
  const reason = [m[2] || '', ...lines.slice(1)].join('\n').trim().slice(0, 500);
  return { command: m[1], reason };
}

function markers(text) {
  return typeof text === 'string' ? [...text.matchAll(MARKER_RE)].map((m) => m[1]) : [];
}

// ctx: { approvers: [lowercase logins], store (Store), outbox (OwnerIssueOutbox), now() }
// Returns { outcome: 'applied'|'already_decided'|'replay'|'ignored', code, approval_id?, command?,
//           issue_number?, reply?, close? }
function evaluateOwnerComment(payload, ctx) {
  const ignore = (code) => ({ outcome: 'ignored', code });
  if (!isPlainObject(payload) || payload.action !== 'created') return ignore('not_created'); // e
  const { issue, comment } = payload;
  if (!isPlainObject(issue) || !isPlainObject(comment) || issue.pull_request) return ignore('not_an_issue');
  const user = isPlainObject(comment.user) ? comment.user : {};
  if (user.type !== 'User') return ignore('not_a_user');
  const login = typeof user.login === 'string' ? user.login.toLowerCase() : '';
  if (!ctx.approvers.includes(login) || comment.author_association !== 'OWNER') return ignore('not_an_approver'); // a

  const author = isPlainObject(issue.user) ? issue.user.login : null;
  if (!BOT_LOGINS.includes(author)) return ignore('issue_not_from_bot'); // b
  const ids = markers(issue.body);
  if (ids.length !== 1) return ignore('no_single_marker');
  const id = ids[0];
  const request = ctx.outbox.list().find((r) => r.approval_id === id);
  if (!request || !request.issue_url || request.issue_url !== issue.html_url) return ignore('issue_not_recorded');

  const cmd = parseCommand(comment.body); // d
  if (!cmd) return ignore('no_command');
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) return ignore('bad_issue_number');
  if (!Number.isSafeInteger(comment.id) || comment.id <= 0) return ignore('bad_comment_id');

  const approval = ctx.store.readApproval(id);
  if (!isPlainObject(approval)) return ignore('no_approval');
  const base = { approval_id: id, command: cmd.command, issue_number: issue.number };
  if (approval.decision_comment_id === comment.id) return { outcome: 'replay', code: 'replay', ...base }; // same event again
  if (approval.status !== 'pending') { // c
    return { outcome: 'already_decided', code: 'already_decided', ...base, reply: `Already decided (status: ${approval.status}). No change.`, close: false };
  }

  const status = cmd.command === 'approve' ? 'approved' : 'denied';
  const at = typeof comment.created_at === 'string' && !Number.isNaN(Date.parse(comment.created_at)) ? comment.created_at : ctx.now();
  ctx.store.writeApproval({
    ...approval,
    status, approved_by: login, approved_at: at,
    decision_source: 'issue_comment',
    decision_comment_id: comment.id,
    decision_comment_url: typeof comment.html_url === 'string' && comment.html_url.startsWith(`${issue.html_url}#issuecomment-`) ? comment.html_url : null,
    decision_reason: cmd.reason, // data only
  });
  const reply = status === 'approved'
    ? `Approved by @${login} (approval \`${id}\`). The loop continues on its next run.`
    : `Denied by @${login} (approval \`${id}\`). The task is blocked until the owner resets it.`;
  return { outcome: 'applied', code: status, ...base, reply, close: true };
}

module.exports = { evaluateOwnerComment, parseCommand, markers, BOT_LOGINS };
