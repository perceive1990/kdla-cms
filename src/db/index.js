'use strict';
const config = require('../config');

let instance = null;

/** Returns the shared database driver (Cosmos in Azure, in-memory locally). */
function getDb() {
  if (!instance) {
    if (config.dbDriver === 'cosmos') {
      const CosmosDriver = require('./cosmos');
      if (!config.cosmos.connectionString && !(config.cosmos.endpoint && config.cosmos.key)) {
        throw new Error('Set COSMOS_CONNECTION_STRING, or COSMOS_ENDPOINT and COSMOS_KEY.');
      }
      instance = new CosmosDriver(config.cosmos);
    } else {
      const MemoryDriver = require('./memory');
      instance = new MemoryDriver({ file: config.memoryDbFile });
    }
  }
  return instance;
}

module.exports = { getDb };
