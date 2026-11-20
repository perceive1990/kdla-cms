'use strict';
// Vue screens. The browser code for the live screens lives in client/: .vue files (one screen or part of a
// screen each) and small .js helpers. When the app starts, every file there becomes a plain JavaScript module
// served from /static/vue/. Templates are compiled here, ahead of time, so browsers run Vue's runtime-only
// build and the security policy keeps allowing scripts from this site only (no eval).
// Every import carries a version, so browsers and the phone app fetch new code right after a deployment while
// unchanged code stays cached.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const RUNTIME_FILE = 'vue.runtime.esm-browser.prod.js';
const RUNTIME_PATH = path.join(ROOT, 'node_modules', 'vue', 'dist', RUNTIME_FILE);
const BASE = '/static/vue/';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

/** Every .vue and .js file under client/, as paths relative to it (a/b.vue). */
function listFiles(dir = CLIENT, rel = '') {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), r));
    else if (/\.(vue|js)$/.test(entry.name)) out.push(r);
  }
  return out;
}

function compileVue(compiler, source, file) {
  const { descriptor, errors } = compiler.parse(source, { filename: file, sourceMap: false });
  if (errors.length) throw new Error(`client/${file}: ${errors[0].message}`);
  if (descriptor.styles.length) throw new Error(`client/${file}: put styles in public/css/app.css, not in a <style> block`);
  if (!descriptor.scriptSetup) throw new Error(`client/${file}: write the component with <script setup>`);
  const id = sha1(file).slice(0, 8);
  return compiler.compileScript(descriptor, {
    id, inlineTemplate: true, isProd: true, sourceMap: false,
  }).content;
}

// Import specifiers at the start of a line (static imports and re-exports) and dynamic import('...') calls.
const STATIC_IMPORT = /^(\s*(?:import|export)\s[^'"]*?\bfrom\s*)(['"])([^'"\n]+)\2/gm;
const BARE_IMPORT = /^(\s*import\s*)(['"])([^'"\n]+)\2/gm;
const DYNAMIC_IMPORT = /(\bimport\(\s*)(['"])([^'"\n]+)\2(?=\s*\))/g;

/**
 * Compile every file in client/. Returns { hash, version, modules } where modules maps a served path
 * (/static/vue/screens/cases-list.js) to its code. Throws on any error, so a broken screen stops the app
 * starting (and fails the tests) instead of failing quietly in the browser.
 */
function build() {
  const vueVersion = require('vue/package.json').version;
  const files = listFiles();
  const raw = new Map();
  if (files.some((f) => f.endsWith('.vue'))) {
    // The compiler is large; whatever it loads is dropped from the module cache afterwards to free the memory.
    const before = new Set(Object.keys(require.cache));
    try {
      const compiler = require('vue/compiler-sfc');
      for (const rel of files) {
        const src = fs.readFileSync(path.join(CLIENT, rel), 'utf8');
        raw.set(rel.replace(/\.vue$/, '.js'), rel.endsWith('.vue') ? compileVue(compiler, src, rel) : src);
      }
    } finally {
      for (const k of Object.keys(require.cache)) if (!before.has(k)) delete require.cache[k];
    }
  } else {
    for (const rel of files) raw.set(rel, fs.readFileSync(path.join(CLIENT, rel), 'utf8'));
  }
  if (raw.size !== files.length) throw new Error('client/: two files compile to the same name (a .vue and a .js with one name)');

  const hash = sha1(`${vueVersion}\n${[...raw].map(([f, c]) => `${f}\n${c}`).join('\n')}`).slice(0, 10);
  const runtime = `/vendor/vue/${RUNTIME_FILE}?v=${vueVersion}`;
  const resolve = (from, spec) => {
    if (spec === 'vue') return runtime;
    if (!spec.startsWith('./') && !spec.startsWith('../')) throw new Error(`client/${from}: cannot import "${spec}" (only "vue" and files in client/ can be imported)`);
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.vue$/, '.js');
    if (!raw.has(target)) throw new Error(`client/${from}: imports "${spec}", which is not in client/`);
    return `${BASE}${target}?v=${hash}`;
  };
  const modules = new Map();
  for (const [file, code] of raw) {
    const swap = (m, head, q, spec) => `${head}${q}${resolve(file, spec)}${q}`;
    const out = code.replace(STATIC_IMPORT, swap).replace(BARE_IMPORT, swap).replace(DYNAMIC_IMPORT, swap);
    if (/\bfrom\s*['"]vue['"]/.test(out)) throw new Error(`client/${file}: an import from "vue" was not rewritten`);
    modules.set(`${BASE}${file}`, out);
  }
  return { hash, version: vueVersion, runtime, modules };
}

/**
 * The compiled screens with a request handler for /static/vue/. In development the files are compiled again
 * when one of them changes, so edits show after a reload without restarting the server.
 */
function createVueScreens({ watch = false, maxAgeSeconds = 0 } = {}) {
  const stamp = () => listFiles().map((f) => `${f}:${fs.statSync(path.join(CLIENT, f)).mtimeMs}`).join('|');
  let built = build();
  let lastStamp = watch ? stamp() : '';
  const current = () => {
    if (watch) {
      const s = stamp();
      if (s !== lastStamp) { built = build(); lastStamp = s; }
    }
    return built;
  };
  const cacheControl = maxAgeSeconds ? `public, max-age=${maxAgeSeconds}, immutable` : 'no-cache';
  return {
    get hash() { return current().hash; },
    get version() { return built.version; },
    runtimePath: RUNTIME_PATH,
    modules: () => current().modules,
    /** Express middleware mounted at /static/vue. */
    handler(req, res, next) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const code = current().modules.get(`${BASE}${req.path.replace(/^\//, '')}`);
      if (code === undefined) return next();
      res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': cacheControl });
      return res.send(code);
    },
  };
}

module.exports = { createVueScreens, build, listFiles, BASE };
