const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

// The window is created with sandbox: true, and a sandboxed preload only gets a
// `require` polyfill that resolves `electron` plus a few node builtins. Any other
// require throws, Electron throws away the whole preload, and the renderer boots
// with no window.api — which showed up as the app hanging on "Setting up tools"
// forever. This test is the guard against that regression.
const ALLOWED_REQUIRES = new Set(['electron', 'events', 'timers', 'url']);

test('preload only requires modules a sandboxed preload can resolve', () => {
  const found = [...preloadSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(found.length > 0, 'expected preload.js to require something');
  for (const id of found) {
    assert.ok(
      ALLOWED_REQUIRES.has(id),
      `preload.js requires ${id}, which a sandboxed preload cannot resolve — move it to main.js and expose it over IPC`
    );
  }
});

test('main.js still creates its windows sandboxed', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(mainSource, /sandbox:\s*true/);
});

// --------------------------------------------------------------- IPC wiring
//
// The three files have to agree on channel names and on the api surface, and
// nothing fails loudly when they don't: an invoke with no handler rejects at
// click time, and a missing api method is a TypeError deep in the renderer.

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
const controlbarSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'controlbar.js'), 'utf8');

const matches = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);

test('every channel the preload invokes has a handler in main', () => {
  const invoked = new Set(matches(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g));
  const handled = new Set(matches(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g));
  const missing = [...invoked].filter((channel) => !handled.has(channel));
  assert.deepStrictEqual(missing, [], `no ipcMain.handle for: ${missing.join(', ')}`);
});

test('every channel the preload sends has a listener in main', () => {
  const sent = new Set(matches(preloadSource, /ipcRenderer\.send\(\s*'([^']+)'/g));
  const listened = new Set(matches(mainSource, /ipcMain\.on\(\s*'([^']+)'/g));
  const missing = [...sent].filter((channel) => !listened.has(channel));
  assert.deepStrictEqual(missing, [], `no ipcMain.on for: ${missing.join(', ')}`);
});

test('every channel the preload listens on is sent by main', () => {
  const listened = new Set(matches(preloadSource, /ipcRenderer\.on\(\s*'([^']+)'/g));
  const missing = [...listened].filter((channel) => !mainSource.includes(`'${channel}'`));
  assert.deepStrictEqual(missing, [], `main never sends: ${missing.join(', ')}`);
});

test('every window.api method the renderers call is exposed by the preload', () => {
  const exposed = new Set(matches(preloadSource, /^\s{2}([A-Za-z0-9_]+):/gm));
  const used = new Set([
    ...matches(rendererSource, /window\.api\.([A-Za-z0-9_]+)/g),
    ...matches(controlbarSource, /window\.api\.([A-Za-z0-9_]+)/g),
  ]);
  const missing = [...used].filter((name) => !exposed.has(name));
  assert.deepStrictEqual(missing, [], `not exposed in preload.js: ${missing.join(', ')}`);
});
