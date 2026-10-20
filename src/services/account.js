'use strict';
// A staff member's own account (password changes and saving their own settings),
// shared by the web pages and the API.
const { verifyPassword, hashPassword, passwordProblem } = require('../auth');
const { audit } = require('../audit');
const { now } = require('../helpers');

/**
 * Save changes to the signed-in user's own account.
 * With bumpEpoch every session and API token of this user ends; the caller keeps its own
 * session or token valid by storing the new user.sessionEpoch.
 */
async function updateSelf(req, patch, { bumpEpoch = false } = {}) {
  const u = await req.db.get('users', req.user.id);
  const next = { ...u, ...patch, updatedAt: now() };
  if (bumpEpoch) next.sessionEpoch = (u.sessionEpoch || 0) + 1;
  const saved = await req.db.replace('users', next);
  req.user = saved;
  return saved;
}

/**
 * Change the signed-in user's password. "confirm" is optional (the API does not send it).
 * Returns { errors } when something is wrong, otherwise { errors: {}, user }.
 */
async function changePassword(req, { current, password, confirm }) {
  const errors = {};
  const check = await verifyPassword(current || '', req.user.passwordHash);
  if (!check.ok) errors.current = 'Your current password is not correct.';
  const problem = passwordProblem(password, req.user.username);
  if (problem) errors.password = problem;
  else if (confirm !== undefined && password !== confirm) errors.confirm = 'The two new passwords do not match.';
  else if (check.ok && current === password) errors.password = 'Choose a password different from the current one.';
  if (Object.keys(errors).length) return { errors };
  const user = await updateSelf(req, { passwordHash: await hashPassword(password), mustChangePassword: false }, { bumpEpoch: true });
  audit(req, 'security', 'users', user.id, 'Changed own password (other devices signed out)');
  return { errors: {}, user };
}

module.exports = { updateSelf, changePassword };
