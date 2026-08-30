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
