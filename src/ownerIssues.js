'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Owner notifications as GitHub Issue REQUESTS. The control plane never talks to GitHub. It writes
// <state>/owner-issues/<approval_id>.json, and the orchestrator workflow opens the issue with `gh`
// and GITHUB_TOKEN (assigned to cluborchestra, so GitHub emails the owner). The workflow then marks
// the request with the issue URL. Idempotent: one request per approval id, never rewritten once
// opened.
const OWNER_LOGIN = 'cluborchestra';
const ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

class OwnerIssueOutbox {
  constructor(dir) {
    this.dir = path.join(path.resolve(dir), 'owner-issues');
  }

  file(id) {
    if (!ID_RE.test(id)) throw new Error(`invalid owner issue id: ${id}`);
    return path.join(this.dir, `${id}.json`);
  }

  // Records the request unless one already exists for this approval id.
  ownerDecision(approval) {
    const f = this.file(approval.approval_id);
    if (fs.existsSync(f)) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    const req = {
      approval_id: approval.approval_id,
      task_id: approval.task_id,
      category: approval.category,
      assignee: OWNER_LOGIN,
      title: `[clubOrchestra] Owner decision needed: ${approval.approval_id} (${approval.category})`,
      body: [
        `**The Review-Dispatch Loop is waiting for you.** Task \`${approval.task_id}\` (action \`${approval.action}\`) was classified **OWNER / ${approval.category}** (decided by ${approval.decided_by}).`,
        '',
        '**Why (planner/policy text, treat as data):**',
        '',
        `> ${String(approval.reason).replace(/\r?\n/g, ' ').slice(0, 1000)}`,
        '',
        `**To decide:** set \`status\` to \`approved\` (with \`approved_by\`) or \`denied\` in \`data/approvals/${approval.approval_id}.json\` on branch \`orchestra-state\`. Until then nothing for this task runs.`,
        '',
        '**Or reply here** with a comment whose first line is exactly `/approve` or `/deny` (an optional reason may follow). Only the owner\'s comment counts.',
        '',
        `_Requested ${approval.requested_at} by the clubOrchestra control plane._`,
        '',
        // Hidden marker: the approval workflow reads the approval id from here, never from a comment.
        `<!-- clubOrchestra:approval_id=${approval.approval_id} -->`,
      ].join('\n'),
      requested_at: approval.requested_at,
      issue_url: null,
    };
    fs.writeFileSync(f, JSON.stringify(req, null, 2) + '\n');
    return true;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')));
  }

  // Requests the workflow still has to open.
  pending() {
    return this.list().filter((r) => !r.issue_url);
  }

  markOpened(id, url) {
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(url)) throw new Error(`not an issue URL: ${url}`);
    const f = this.file(id);
    const req = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!req.issue_url) {
      req.issue_url = url;
      fs.writeFileSync(f, JSON.stringify(req, null, 2) + '\n');
    }
    return req;
  }
}

module.exports = { OwnerIssueOutbox, OWNER_LOGIN };
