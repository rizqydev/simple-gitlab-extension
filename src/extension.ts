import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    try {
      await execAsync('glab --version', { cwd });
    } catch {
      vscode.window.showErrorMessage('glab CLI not found. Please install it (e.g. winget install glab) and ensure it is in PATH.');
      return;
    }

    try {
      await execAsync('git rev-parse --is-inside-work-tree', { cwd });
    } catch {
      vscode.window.showErrorMessage('Current workspace is not inside a Git repository.');
      return;
    }

    let currentBranch = '';
    let lastCommitMsg = '';
    try {
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd });
      currentBranch = branchOut.trim();

      const { stdout: commitOut } = await execAsync('git log -1 --pretty=%B', { cwd });
      lastCommitMsg = commitOut.trim().split('\n')[0];
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed reading git info: ${e.message}`);
      return;
    }

    const config = vscode.workspace.getConfiguration('gitlabMr');
    const defaultTarget = config.get<string>('target', 'development');
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
      const { stdout: statusOut } = await execAsync('git status --porcelain', { cwd });
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
              await execAsync(`git push -u origin "${currentBranch}"`, { cwd });

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

              const { stdout } = await execFileAsync('glab', args, { cwd });

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
}

function getWebviewContent(init: {
  branch: string;
  defaultTitle: string;
  defaultTarget: string;
  assignees: string[];
  defaultAssignee: string;
  reviewers: string[];
  defaultReviewer: string;
  labels: string;
  squash: boolean;
  removeBranch: boolean;
  openInWeb: boolean;
}) {
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
      <input type="text" id="target" value="${init.defaultTarget}" />
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

export function deactivate() {}
