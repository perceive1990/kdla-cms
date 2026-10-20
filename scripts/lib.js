'use strict';
const config = require('../src/config');
const { hashPassword } = require('../src/auth');
const { newId, now } = require('../src/helpers');

/** Creates the first administrator from ADMIN_USERNAME / ADMIN_PASSWORD when no administrator exists. */
async function ensureBootstrapAdmin(db) {
  const { username, password } = config.bootstrapAdmin;
  if (!username || !password) return;
  if ((await db.count('users', { where: { role: 'admin' } })) > 0) return;
  if ((await db.count('users', { where: { username: String(username).trim().toLowerCase() } })) > 0) return;
  await createUser(db, {
    username, password, role: 'admin', fullName: 'System Administrator', mustChangePassword: true,
  });
  console.log(`Created first administrator "${username}". Remove ADMIN_PASSWORD from settings after logging in.`);
}

async function createUser(db, {
  username, password, role = 'officer', fullName = '', email = '', category = '', office = '', mustChangePassword = false,
}) {
  const uname = String(username).trim().toLowerCase();
  const doc = {
    id: newId(),
    username: uname,
    fullName,
    email,
    role,
    category,
    qualification: '',
    office,
    active: true,
    mustChangePassword,
    passwordHash: await hashPassword(password),
    createdAt: now(),
    updatedAt: now(),
  };
  return db.create('users', doc);
}

module.exports = { ensureBootstrapAdmin, createUser };
