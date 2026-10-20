'use strict';
// Creates the Cosmos DB database and containers (the app also does this on start-up).
const config = require('../src/config');
const { getDb } = require('../src/db');
const containers = require('../src/db/containers');

getDb().init()
  .then(() => {
    console.log(`Database "${config.cosmos.database}" ready (${config.dbDriver}). Containers: ${Object.keys(containers).join(', ')}`);
  })
  .catch((e) => { console.error(e.message || e); process.exit(1); });
