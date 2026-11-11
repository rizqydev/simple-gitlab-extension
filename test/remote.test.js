const assert = require('assert');
const Module = require('module');

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...args);
};
require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    window: { registerWebviewViewProvider: () => ({}) },
    commands: { registerCommand: () => ({}) },
    workspace: { getConfiguration: () => ({ get: () => '' }) }
  }
};

const { parseGitlabRemote } = require('../out/extension');

// 1. Standard SSH
assert.deepStrictEqual(parseGitlabRemote('git@gitlab.com:org/repo.git'), {
  host: 'https://gitlab.com',
  projectPath: 'org/repo'
});

// 2. SSH with nested subgroup
assert.deepStrictEqual(parseGitlabRemote('git@gitlab.com:org/subgroup/team/repo.git'), {
  host: 'https://gitlab.com',
  projectPath: 'org/subgroup/team/repo'
});

// 3. Standard HTTPS
assert.deepStrictEqual(parseGitlabRemote('https://gitlab.com/org/repo.git'), {
  host: 'https://gitlab.com',
  projectPath: 'org/repo'
});

// 4. Custom self-hosted host with custom HTTPS port
assert.deepStrictEqual(parseGitlabRemote('https://gitlab.internal.net:8443/company/api.git'), {
  host: 'https://gitlab.internal.net:8443',
  projectPath: 'company/api'
});

// 5. SSH protocol with port
assert.deepStrictEqual(parseGitlabRemote('ssh://git@gitlab.custom.org:2222/org/repo.git'), {
  host: 'https://gitlab.custom.org',
  projectPath: 'org/repo'
});

console.log('✓ parseGitlabRemote tests passed');
