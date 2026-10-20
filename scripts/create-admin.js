'use strict';
// Create an administrator account.  Usage: npm run create-admin -- <username> <password> ["Full Name"]
const { getDb } = require('../src/db');
const { passwordProblem } = require('../src/auth');
const { createUser } = require('./lib');

async function main() {
  const [username, password, fullName = ''] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run create-admin -- <username> <password> ["Full Name"]');
    process.exit(1);
  }
  const problem = passwordProblem(password, username);
  if (problem) { console.error(problem); process.exit(1); }
  const db = getDb();
  await db.init();
  if (await db.count('users', { where: { username: username.toLowerCase() } })) {
    console.error(`User ${username} already exists.`);
    process.exit(1);
  }
  await createUser(db, { username, password, fullName, role: 'admin' });
  console.log(`Administrator ${username.toLowerCase()} created.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
