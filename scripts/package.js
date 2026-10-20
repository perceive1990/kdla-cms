'use strict';
/**
 * Builds a .zip of the project using only Node.js (no zip program needed).
 *
 *   node scripts/package.js app.zip            deployment package (no tests, no node_modules)
 *   node scripts/package.js out.zip --source   full source, including tests
 *   node scripts/package.js out.zip --source --prefix kdla-cms/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const out = path.resolve(args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--prefix') || 'app.zip');
const source = args.includes('--source');
const prefixIdx = args.indexOf('--prefix');
const prefix = prefixIdx >= 0 ? String(args[prefixIdx + 1] || '').replace(/^\/+/, '') : '';
const root = path.resolve(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', 'data', '.git', ...(source ? [] : ['test', '.github'])]);
const SKIP_FILES = (name) => name === '.env' || name.endsWith('.log') || name.endsWith('.zip') || name === '.DS_Store';

// CRC-32 (the checksum the zip format requires)
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function walk(dir, rel = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...walk(full, r));
    } else if (entry.isFile() && !SKIP_FILES(entry.name) && full !== out) {
      files.push({ full, rel: r });
    }
  }
  return files;
}

const parts = [];
const central = [];
let offset = 0;
const files = walk(root);
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const stat = fs.statSync(f.full);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const name = Buffer.from(prefix + f.rel, 'utf8');
  const { time, date } = dosTime(stat.mtime);
  const crc = crc32(data);
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // file names are UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  parts.push(local, name, body);

  const mode = f.rel.endsWith('.sh') ? 0o100755 : 0o100644;
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, zip 2.0
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(method, 10);
  cen.writeUInt16LE(time, 12);
  cen.writeUInt16LE(date, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt16LE(0, 30);
  cen.writeUInt16LE(0, 32);
  cen.writeUInt16LE(0, 34);
  cen.writeUInt16LE(0, 36);
  cen.writeUInt32LE((mode << 16) >>> 0, 38);
  cen.writeUInt32LE(offset, 42);
  central.push(cen, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(out, Buffer.concat([...parts, centralBuf, end]));
console.log(`Wrote ${out} (${files.length} files, ${Math.round(fs.statSync(out).size / 1024)} KB)`);
