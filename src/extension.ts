import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

function getExecOptions(cwd: string) {
  const homeDir = process.env.HOME || '';
  const extraPaths = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/sbin',
    '/usr/local/sbin',
    '/snap/bin',
    homeDir ? `${homeDir}/.local/bin` : ''
  ];
  const currentPath = process.env.PATH || '';
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const newPath = [currentPath, ...extraPaths].filter(Boolean).join(pathSeparator);
  return {
    cwd,
    env: { ...process.env, PATH: newPath }
  };
}

async function resolveGitRepoRoot(): Promise<string | undefined> {
  let targetDir: string | undefined;

  if (vscode.window.activeTextEditor) {
    const docUri = vscode.window.activeTextEditor.document.uri;
    const wf = vscode.workspace.getWorkspaceFolder(docUri);
    if (wf) {
      targetDir = wf.uri.fsPath;
    } else if (docUri.scheme === 'file') {
      targetDir = vscode.Uri.joinPath(docUri, '..').fsPath;
    }
  }

  if (!targetDir) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      targetDir = workspaceFolders[0].uri.fsPath;
    }
  }

  if (!targetDir) {
    vscode.window.showErrorMessage('No workspace folder or file open.');
    return undefined;
  }

  try {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', getExecOptions(targetDir));
    return stdout.trim();
  } catch (err: any) {
    const detail = (err.stderr ? err.stderr.trim() : err.message) || 'Unknown git error';
    vscode.window.showErrorMessage(`Git repository not detected in '${targetDir}': ${detail}`);
    return undefined;
  }
}

interface MRFormData {
  title: string;
  description: string;
  target: string;
  assignee: string;
  reviewer: string;
  labels: string[];
  draft: boolean;
  squash: boolean;
  removeBranch: boolean;
  openInWeb: boolean;
}

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('gitlabMr.create', async () => {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      return;
    }

    try {
      await execAsync('glab --version', getExecOptions(cwd));
    } catch {
      vscode.window.showErrorMessage('glab CLI not found. Please install it (e.g. "brew install glab" on macOS or "winget install glab" on Windows) and ensure it is in PATH.');
      return;
    }

    let currentBranch = '';
    let lastCommitMsg = '';
    let targetBranches: string[] = [];
    const config = vscode.workspace.getConfiguration('gitlabMr');
    const defaultTarget = config.get<string>('target', 'development');

    try {
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', getExecOptions(cwd));
      currentBranch = branchOut.trim();

      const { stdout: commitOut } = await execAsync('git log -1 --pretty=%B', getExecOptions(cwd));
      lastCommitMsg = commitOut.trim().split('\n')[0];

      const { stdout: listOut } = await execAsync('git branch -a --format="%(refname:short)"', getExecOptions(cwd));
      const rawBranches = listOut.split('\n').map(b => b.trim()).filter(Boolean);
      const cleanBranches = rawBranches
        .map(b => b.replace(/^origin\//, ''))
        .filter(b => b && !b.includes('HEAD'));
      targetBranches = Array.from(new Set([defaultTarget, ...cleanBranches]));
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed reading git info: ${e.message}`);
      return;
    }

    const assignees = config.get<string[]>('assignees', []);
    const defaultAssignee = config.get<string>('defaultAssignee', '');
    const reviewers = config.get<string[]>('reviewers', []);
    const defaultReviewer = config.get<string>('defaultReviewer', '');
    const labels = config.get<string[]>('labels', []);
    const squash = config.get<boolean>('squash', false);
    const removeBranch = config.get<boolean>('removeBranch', false);
    const openInWeb = config.get<boolean>('openInWeb', true);

    if (currentBranch === defaultTarget) {
      vscode.window.showWarningMessage(`You are on target branch '${defaultTarget}'. Switch to a feature branch first.`);
      return;
    }

    try {
      const { stdout: statusOut } = await execAsync('git status --porcelain', getExecOptions(cwd));
      if (statusOut.trim().length > 0) {
        vscode.window.showWarningMessage('You have uncommitted changes. They will not be included in the MR.');
      }
    } catch {
      // ignore
    }

    const panel = vscode.window.createWebviewPanel(
      'gitlabMrCreate',
      'Create GitLab MR',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getWebviewContent({
      branch: currentBranch,
      defaultTitle: lastCommitMsg || currentBranch,
      defaultTarget,
      targetBranches,
      assignees,
      defaultAssignee,
      reviewers,
      defaultReviewer,
      labels: labels.join(','),
      squash,
      removeBranch,
      openInWeb
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'submit') {
        const data: MRFormData = message.data;
        panel.dispose();

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating MR for ${currentBranch}...`,
            cancellable: false
          },
          async () => {
            try {
              // 1. Git push
              await execAsync(`git push -u origin "${currentBranch}"`, getExecOptions(cwd));

              // 2. Build glab arguments as an array for execFile (avoids Windows cmd quote escaping bugs)
              const args: string[] = [
                'mr', 'create',
                '-t', data.title,
                '--source-branch', currentBranch,
                '--target-branch', data.target,
              ];

              if (data.description && data.description.trim()) {
                args.push('--description', data.description);
              } else {
                args.push('--description', ' ');
              }
              if (data.assignee) {
                args.push('--assignee', data.assignee);
              }
              if (data.reviewer) {
                args.push('--reviewer', data.reviewer);
              }
              if (data.labels && data.labels.length > 0) {
                args.push('--label', data.labels.join(','));
              }
              if (data.draft) {
                args.push('--draft');
              }
              if (data.squash) {
                args.push('--squash-before-merge');
              }
              if (data.removeBranch) {
                args.push('--remove-source-branch');
              }

              const { stdout } = await execFileAsync('glab', args, getExecOptions(cwd));

              // Extract MR URL if present in output to open or link
              const mrUrlMatch = stdout.match(/https?:\/\/[^\s]+/);
              if (data.openInWeb && mrUrlMatch) {
                vscode.env.openExternal(vscode.Uri.parse(mrUrlMatch[0]));
              }

              vscode.window.showInformationMessage(`Merge Request created successfully!\n${stdout}`);
            } catch (err: any) {
              vscode.window.showErrorMessage(`Failed creating MR: ${err.message}`);
            }
          }
        );
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(disposable);

  const tagDisposable = vscode.commands.registerCommand('gitlabTag.create', async () => {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      return;
    }

    let currentBranch = '';
    let branches: string[] = [];
    let latestTags: string[] = [];
    let defaultBranch = '';

    // Fetch latest tags and remote branches from origin so we're in sync
    try {
      await execAsync('git fetch origin --tags', getExecOptions(cwd));
    } catch {
      // ignore if offline
    }

    try {
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', getExecOptions(cwd));
      currentBranch = branchOut.trim();

      // Remote branches from origin
      let cleanRemote: string[] = [];
      try {
        const { stdout: remoteOut } = await execAsync('git branch -r --format="%(refname:short)"', getExecOptions(cwd));
        cleanRemote = remoteOut.split('\n')
          .map(b => b.trim())
          .filter(b => b && b !== 'origin' && !b.includes('HEAD'))
          .map(b => b.replace(/^origin\//, ''));
      } catch {
        // ignore
      }

      // Local branches
      const { stdout: localOut } = await execAsync('git branch --format="%(refname:short)"', getExecOptions(cwd));
      const cleanLocal = localOut.split('\n').map(b => b.trim()).filter(Boolean);

      // Default to 'development' if available, otherwise current branch
      defaultBranch = currentBranch;
      if (cleanRemote.includes('development') || cleanLocal.includes('development')) {
        defaultBranch = 'development';
      } else if (cleanRemote.includes(currentBranch) || cleanLocal.includes(currentBranch)) {
        defaultBranch = currentBranch;
      }

      branches = Array.from(new Set([defaultBranch, ...cleanRemote, ...cleanLocal]));

      const { stdout: tagOut } = await execAsync('git for-each-ref --count=3 --sort=-v:refname --format="%(refname:short)" refs/tags', getExecOptions(cwd));
      latestTags = tagOut.split('\n').map(t => t.trim()).filter(Boolean);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed reading git info: ${e.message}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitlabTagCreate',
      'Create New Tag',
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getTagWebviewContent({
      currentBranch: defaultBranch,
      branches,
      latestTags
    });

    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'cancel') {
        panel.dispose();
      } else if (message.command === 'submit') {
        const { tagName, createFrom, message: tagMessage } = message.data;
        panel.dispose();

        if (!tagName) {
          vscode.window.showErrorMessage('Tag name cannot be empty.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating tag '${tagName}'...`,
            cancellable: false
          },
          async () => {
            try {
              // Ensure origin is up-to-date for the selected branch/tag
              try {
                await execAsync('git fetch origin --tags', getExecOptions(cwd));
              } catch {
                // ignore if offline
              }

              // Resolve to origin/<createFrom> if it exists on origin
              let targetRef = createFrom;
              try {
                await execAsync(`git rev-parse --verify "origin/${createFrom}"`, getExecOptions(cwd));
                targetRef = `origin/${createFrom}`;
              } catch {
                // If not found on origin, use createFrom directly (local branch/tag/SHA)
                targetRef = createFrom;
              }

              // 1. Create tag locally pointing to targetRef (e.g. origin/development)
              const tagArgs = ['tag'];
              if (tagMessage && tagMessage.trim()) {
                tagArgs.push('-a', tagName, targetRef, '-m', tagMessage.trim());
              } else {
                tagArgs.push(tagName, targetRef);
              }

              await execFileAsync('git', tagArgs, getExecOptions(cwd));

              // 2. Prompt for push confirmation
              const pushChoice = await vscode.window.showInformationMessage(
                `Tag '${tagName}' created on '${targetRef}'. Push to origin?`,
                'Push',
                'Cancel'
              );

              if (pushChoice === 'Push') {
                await vscode.window.withProgress(
                  {
                    location: vscode.ProgressLocation.Notification,
                    title: `Pushing tag '${tagName}' to origin...`,
                    cancellable: false
                  },
                  async () => {
                    await execAsync(`git push origin "${tagName}"`, getExecOptions(cwd));
                    vscode.window.showInformationMessage(`Tag '${tagName}' pushed to origin successfully!`);
                  }
                );
              }
            } catch (err: any) {
              vscode.window.showErrorMessage(`Failed creating tag: ${err.message}`);
            }
          }
        );
      }
    }, undefined, context.subscriptions);
  });

  context.subscriptions.push(tagDisposable);
}

function getWebviewContent(init: {
  branch: string;
  defaultTitle: string;
  defaultTarget: string;
  targetBranches: string[];
  assignees: string[];
  defaultAssignee: string;
  reviewers: string[];
  defaultReviewer: string;
  labels: string;
  squash: boolean;
  removeBranch: boolean;
  openInWeb: boolean;
}) {
  const targetOptions = init.targetBranches.map(t =>
    `<option value="${t}" ${t === init.defaultTarget ? 'selected' : ''}>${t}</option>`
  ).join('');

  const assigneeOptions = init.assignees.map(a =>
    `<option value="${a}" ${a === init.defaultAssignee ? 'selected' : ''}>${a}</option>`
  ).join('');

  const reviewerOptions = init.reviewers.map(r =>
    `<option value="${r}" ${r === init.defaultReviewer ? 'selected' : ''}>${r}</option>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 16px;
      margin: 0;
    }
    .field {
      margin-bottom: 12px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 4px;
    }
    input[type="text"], textarea, select {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 2px;
    }
    .checkbox-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 14px 0;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: normal;
      cursor: pointer;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 14px;
      cursor: pointer;
      font-size: 13px;
      border-radius: 2px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-size: 11px;
    }
  </style>
</head>
<body>
  <h3>New GitLab Merge Request</h3>
  <div class="field">
    <span>Source Branch: </span><span class="badge">${init.branch}</span>
  </div>

  <form id="mrForm">
    <div class="field">
      <label for="title">Title *</label>
      <input type="text" id="title" required value="${init.defaultTitle.replace(/"/g, '&quot;')}" />
    </div>

    <div class="field">
      <label for="target">Target Branch</label>
      <select id="target">
        ${targetOptions}
      </select>
    </div>

    <div class="field">
      <label for="assignee">Assignee</label>
      <select id="assignee">
        <option value="">None</option>
        ${assigneeOptions}
      </select>
    </div>

    <div class="field">
      <label for="reviewer">Reviewer</label>
      <select id="reviewer">
        <option value="">None</option>
        ${reviewerOptions}
      </select>
    </div>

    <div class="field">
      <label for="description">Description</label>
      <textarea id="description" rows="4"></textarea>
    </div>

    <div class="field">
      <label for="labels">Labels (comma-separated)</label>
      <input type="text" id="labels" value="${init.labels}" />
    </div>

    <div class="checkbox-group">
      <label class="checkbox-label">
        <input type="checkbox" id="draft" /> Mark as Draft (WIP)
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="squash" ${init.squash ? 'checked' : ''} /> Squash commits on merge
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="removeBranch" ${init.removeBranch ? 'checked' : ''} /> Delete source branch after merge
      </label>
      <label class="checkbox-label">
        <input type="checkbox" id="openInWeb" ${init.openInWeb ? 'checked' : ''} /> Open MR in browser
      </label>
    </div>

    <button type="submit">Create Merge Request</button>
  </form>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('mrForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const labelsVal = document.getElementById('labels').value.trim();
      vscode.postMessage({
        command: 'submit',
        data: {
          title: document.getElementById('title').value.trim(),
          target: document.getElementById('target').value.trim(),
          assignee: document.getElementById('assignee').value,
          reviewer: document.getElementById('reviewer').value,
          description: document.getElementById('description').value,
          labels: labelsVal ? labelsVal.split(',').map(s => s.trim()).filter(Boolean) : [],
          draft: document.getElementById('draft').checked,
          squash: document.getElementById('squash').checked,
          removeBranch: document.getElementById('removeBranch').checked,
          openInWeb: document.getElementById('openInWeb').checked
        }
      });
    });
  </script>
</body>
</html>`;
}

function getTagWebviewContent(init: {
  currentBranch: string;
  branches: string[];
  latestTags: string[];
}) {
  const branchOptions = init.branches.map(b =>
    `<option value="${b}" ${b === init.currentBranch ? 'selected' : ''}>${b}</option>`
  ).join('');

  const recentTagsHtml = init.latestTags && init.latestTags.length > 0 ? `
    <div class="recent-tags">
      <span class="recent-tags-title">Recent tags:</span>
      <div class="recent-tags-list">
        ${init.latestTags.map(t => `<button type="button" class="tag-pill" data-tag="${t.replace(/"/g, '&quot;')}">${t}</button>`).join('')}
      </div>
    </div>
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      margin: 0;
      max-width: 650px;
    }
    h2 {
      margin-top: 0;
      font-weight: 600;
      font-size: 20px;
      margin-bottom: 6px;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      margin-bottom: 22px;
    }
    .field {
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 6px;
    }
    input[type="text"], textarea, select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
    }
    .recent-tags {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .recent-tags-title {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    .recent-tags-list {
      display: inline-flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag-pill {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid transparent;
      border-radius: 12px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      line-height: 1.4;
      transition: opacity 0.15s ease;
    }
    .tag-pill:hover {
      opacity: 0.8;
      border-color: var(--vscode-focusBorder);
    }
    textarea {
      resize: vertical;
      min-height: 90px;
    }
    .help-text {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-top: 6px;
    }
    .button-group {
      display: flex;
      gap: 10px;
      margin-top: 24px;
    }
    button.primary, button.secondary {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <h2>New tag</h2>
  <div class="subtitle">Do you want to create a release with the new tag? You can do that in the new release page.</div>

  <form id="tagForm">
    <div class="field">
      <label for="tagName">Tag name</label>
      <input type="text" id="tagName" required autofocus />
      ${recentTagsHtml}
    </div>

    <div class="field">
      <label for="createFrom">Create from</label>
      <select id="createFrom">
        ${branchOptions}
      </select>
      <div class="help-text">Existing branch name, tag, or commit SHA</div>
    </div>

    <div class="field">
      <label for="message">Message</label>
      <textarea id="message"></textarea>
      <div class="help-text">Optionally, add a message to the tag. Leaving this blank creates a lightweight tag.</div>
    </div>

    <div class="button-group">
      <button type="submit" class="primary">Create tag</button>
      <button type="button" id="cancelBtn" class="secondary">Cancel</button>
    </div>
  </form>

  <script>
    const vscode = acquireVsCodeApi();

    document.querySelectorAll('.tag-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-tag');
        const input = document.getElementById('tagName');
        input.value = val;
        input.focus();
        input.select();
      });
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    document.getElementById('tagForm').addEventListener('submit', (e) => {
      e.preventDefault();
      vscode.postMessage({
        command: 'submit',
        data: {
          tagName: document.getElementById('tagName').value.trim(),
          createFrom: document.getElementById('createFrom').value,
          message: document.getElementById('message').value
        }
      });
    });
  </script>
</body>
</html>`;
}

export function deactivate() {}
