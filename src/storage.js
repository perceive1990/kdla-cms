'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

/**
 * Attachment storage. Files are never served publicly: they stream through an
 * authenticated route.
 *  - Azure Blob Storage when AZURE_STORAGE_CONNECTION_STRING is set (recommended).
 *  - Otherwise the local disk. On App Service, /home is persistent storage shared by restarts.
 */
function safeName(name) {
  return String(name || 'file').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
}

function newKey(originalName) {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}-${safeName(originalName)}`;
}

class DiskStorage {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }

  _path(key) {
    const p = path.resolve(this.dir, key);
    if (!p.startsWith(this.dir + path.sep)) throw new Error('Invalid file key');
    return p;
  }

  async save(file) {
    const key = newKey(file.originalname);
    const p = this._path(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, file.buffer);
    return key;
  }

  async stream(key, res) {
    const p = this._path(key);
    if (!fs.existsSync(p)) return false;
    await new Promise((resolve, reject) => {
      fs.createReadStream(p).on('error', reject).on('end', resolve).pipe(res);
    });
    return true;
  }

  async remove(key) {
    try { await fs.promises.unlink(this._path(key)); } catch (e) { /* already gone */ }
  }
}

class BlobStorage {
  constructor(conn, containerName) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    this.container = BlobServiceClient.fromConnectionString(conn).getContainerClient(containerName);
    this.ready = this.container.createIfNotExists(); // private container (no public access)
  }

  async save(file) {
    await this.ready;
    const key = newKey(file.originalname);
    await this.container.getBlockBlobClient(key).uploadData(file.buffer, {
      blobHTTPHeaders: { blobContentType: file.mimetype || 'application/octet-stream' },
    });
    return key;
  }

  async stream(key, res) {
    await this.ready;
    const blob = this.container.getBlobClient(key);
    if (!(await blob.exists())) return false;
    const dl = await blob.download();
    await new Promise((resolve, reject) => {
      dl.readableStreamBody.on('error', reject).on('end', resolve).pipe(res);
    });
    return true;
  }

  async remove(key) {
    await this.ready;
    await this.container.getBlobClient(key).deleteIfExists();
  }
}

let instance;
function getStorage() {
  if (!instance) {
    instance = config.storage.blobConnectionString
      ? new BlobStorage(config.storage.blobConnectionString, config.storage.blobContainer)
      : new DiskStorage(config.storage.uploadDir);
  }
  return instance;
}

module.exports = { getStorage, safeName };
