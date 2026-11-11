const assert = require('assert');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: {} };

const { filterAndSortTags } = require('../out/extension');

const sampleTags = [
  'alpha.1.3.17',
  'lpha.1.4.33',
  'alpha.1.4.33',
  'alpha.1.3.86',
  'alpha.0.0.46',
  'v1.0.0'
];

const result = filterAndSortTags(sampleTags, 3);
assert.deepStrictEqual(result, ['alpha.1.4.33', 'alpha.1.3.86', 'alpha.1.3.17']);

console.log('✓ Tags test passed');
