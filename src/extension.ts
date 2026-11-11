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

interface GitlabProjectInfo {
  host: string;
  projectPath: string;
}

export function parseGitlabRemote(url: string): GitlabProjectInfo | undefined {
  const cleaned = url.trim().replace(/\.git$/, '');

  if (cleaned.startsWith('git@')) {
    const colonIdx = cleaned.indexOf(':');
    if (colonIdx !== -1) {
      const host = cleaned.substring(4, colonIdx);
      const projectPath = cleaned.substring(colonIdx + 1).replace(/^\/+/, '');
      return { host: `https://${host}`, projectPath };
    }
  }

  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === 'ssh:') {
      return { host: `https://${parsed.hostname}`, projectPath: parsed.pathname.replace(/^\/+/, '') };
    }
    return { host: `${parsed.protocol}//${parsed.host}`, projectPath: parsed.pathname.replace(/^\/+/, '') };
  } catch {
    const match = cleaned.match(/^(?:[\w-]+@)?([^:]+):(.+)$/);
    if (match) {
      return { host: `https://${match[1]}`, projectPath: match[2].replace(/^\/+/, '') };
    }
  }

  return undefined;
}

async function getGitlabToken(context: vscode.ExtensionContext, promptIfMissing = false): Promise<string | undefined> {
  let token = await context.secrets.get('gitlabToken');
  if (!token) {
    const config = vscode.workspace.getConfiguration('gitlabMr');
    token = config.get<string>('token', '');
  }

  if (!token && promptIfMissing) {
    const input = await vscode.window.showInputBox({
      title: 'GitLab Personal Access Token',
      prompt: 'Enter your GitLab Personal Access Token (requires "api" scope)',
      password: true,
      ignoreFocusOut: true
    });
    if (input && input.trim()) {
      token = input.trim();
      await context.secrets.store('gitlabToken', token);
      vscode.window.showInformationMessage('GitLab Personal Access Token saved securely.');
    }
  }

  return token || undefined;
}

async function getUserIdByUsername(apiBase: string, token: string, username: string): Promise<number | undefined> {
  if (!username) {
    return undefined;
  }
  try {
    const res = await fetch(`${apiBase}/api/v4/users?username=${encodeURIComponent(username)}`, {
      headers: { 'PRIVATE-TOKEN': token }
    });
    if (!res.ok) {
      return undefined;
    }
    const users = (await res.json()) as Array<{ id: number; username: string }>;
    if (Array.isArray(users) && users.length > 0) {
      const match = users.find(u => u.username.toLowerCase() === username.toLowerCase());
      return match ? match.id : users[0].id;
    }
  } catch {
    // ignore
  }
  return undefined;
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
  const sidebarProvider = new GitlabSidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GitlabSidebarProvider.viewType, sidebarProvider)
  );

  const mrDisposable = vscode.commands.registerCommand('gitlabMr.create', async () => {
    await vscode.commands.executeCommand('simpleGitlab.sidebarView.focus');
    await sidebarProvider.showMr();
  });
  context.subscriptions.push(mrDisposable);

  const tagDisposable = vscode.commands.registerCommand('gitlabTag.create', async () => {
    await vscode.commands.executeCommand('simpleGitlab.sidebarView.focus');
    await sidebarProvider.showTag();
  });
  context.subscriptions.push(tagDisposable);

  const setTokenDisposable = vscode.commands.registerCommand('gitlab.setToken', async () => {
    const hasCurrent = !!(await context.secrets.get('gitlabToken'));
    const input = await vscode.window.showInputBox({
      title: 'GitLab Personal Access Token',
      prompt: hasCurrent
        ? 'Enter a new GitLab Personal Access Token, or leave blank to remove'
        : 'Enter your GitLab Personal Access Token (requires "api" scope)',
      password: true,
      ignoreFocusOut: true
    });
    if (input !== undefined) {
      if (input.trim()) {
        await context.secrets.store('gitlabToken', input.trim());
        vscode.window.showInformationMessage('GitLab Personal Access Token saved securely.');
      } else if (hasCurrent) {
        await context.secrets.delete('gitlabToken');
        vscode.window.showInformationMessage('GitLab Personal Access Token removed.');
      }
    }
  });
  context.subscriptions.push(setTokenDisposable);
}

class GitlabSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'simpleGitlab.sidebarView';
  private _view?: vscode.WebviewView;
  private _pendingTab?: 'mr' | 'tag';

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri]
    };

    webviewView.webview.html = getMainSidebarHtml();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'loadMr') {
        await this.loadMrData();
      } else if (message.command === 'loadTag') {
        await this.loadTagData();
      } else if (message.command === 'submitMr') {
        await this.submitMr(message.data);
      } else if (message.command === 'submitTag') {
        await this.submitTag(message.data);
      } else if (message.command === 'cancel') {
        this.clearForm();
      }
    });

    if (this._pendingTab) {
      const tab = this._pendingTab;
      this._pendingTab = undefined;
      if (tab === 'mr') {
        this.loadMrData();
      } else if (tab === 'tag') {
        this.loadTagData();
      }
    }
  }

  public async showMr() {
    if (this._view) {
      await this.loadMrData();
    } else {
      this._pendingTab = 'mr';
    }
  }

  public async showTag() {
    if (this._view) {
      await this.loadTagData();
    } else {
      this._pendingTab = 'tag';
    }
  }

  public clearForm() {
    this._view?.webview.postMessage({ command: 'reset', message: 'Select an action above to get started.' });
  }

  private async loadMrData() {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      this._view?.webview.postMessage({ command: 'reset', message: 'No git repository detected.' });
      return;
    }

    let remoteUrl = '';
    try {
      const { stdout } = await execAsync('git remote get-url origin', getExecOptions(cwd));
      remoteUrl = stdout.trim();
    } catch {
      vscode.window.showErrorMessage('No "origin" git remote found.');
      this._view?.webview.postMessage({ command: 'reset', message: 'No "origin" git remote found.' });
      return;
    }

    const projectInfo = parseGitlabRemote(remoteUrl);
    if (!projectInfo) {
      vscode.window.showErrorMessage(`Could not parse GitLab project from remote URL: ${remoteUrl}`);
      this._view?.webview.postMessage({ command: 'reset', message: 'Invalid GitLab remote URL.' });
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
      this._view?.webview.postMessage({ command: 'reset', message: `Failed reading git info: ${e.message}` });
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
    }

    try {
      const { stdout: statusOut } = await execAsync('git status --porcelain', getExecOptions(cwd));
      if (statusOut.trim().length > 0) {
        vscode.window.showWarningMessage('You have uncommitted changes. They will not be included in the MR.');
      }
    } catch {
      // ignore
    }

    const html = getMrFormHtml({
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

    this._view?.webview.postMessage({ command: 'render', tab: 'mr', html });
  }

  private async loadTagData() {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      this._view?.webview.postMessage({ command: 'reset', message: 'No git repository detected.' });
      return;
    }

    let currentBranch = '';
    let branches: string[] = [];
    let latestTags: string[] = [];
    let defaultBranch = '';

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Fetching latest tags from remote repository...',
        cancellable: false
      },
      async () => {
        let remote = 'origin';
        try {
          const { stdout: remotesOut } = await execAsync('git remote', getExecOptions(cwd));
          const remotes = remotesOut.split('\n').map(r => r.trim()).filter(Boolean);
          if (remotes.length > 0 && !remotes.includes('origin')) {
            remote = remotes[0];
          }
        } catch {
          // ignore
        }

        // 1. Fetch latest tags and remote branches from remote
        try {
          await execAsync(`git fetch ${remote} --tags --force`, getExecOptions(cwd));
        } catch {
          // ignore if offline
        }

        try {
          const { stdout: tagOut } = await execAsync('git for-each-ref --sort=-creatordate --count=5 --format="%(refname:short)" refs/tags', getExecOptions(cwd));
          latestTags = tagOut.split('\n').map(t => t.trim()).filter(Boolean);
        } catch {
          // ignore
        }

        try {
          const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', getExecOptions(cwd));
          currentBranch = branchOut.trim();

          // Remote branches from remote
          let cleanRemote: string[] = [];
          try {
            const { stdout: remoteOut } = await execAsync('git branch -r --format="%(refname:short)"', getExecOptions(cwd));
            cleanRemote = remoteOut.split('\n')
              .map(b => b.trim())
              .filter(b => b && b !== remote && !b.includes('HEAD'))
              .map(b => b.replace(new RegExp(`^${remote}\\/`), ''));
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
        } catch (e: any) {
          vscode.window.showErrorMessage(`Failed reading git info: ${e.message}`);
        }
      }
    );

    const html = getTagFormHtml({
      currentBranch: defaultBranch,
      branches,
      latestTags
    });

    this._view?.webview.postMessage({ command: 'render', tab: 'tag', html });
  }

  private async submitMr(data: MRFormData) {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      return;
    }

    let remoteUrl = '';
    try {
      const { stdout } = await execAsync('git remote get-url origin', getExecOptions(cwd));
      remoteUrl = stdout.trim();
    } catch {
      vscode.window.showErrorMessage('No "origin" git remote found.');
      return;
    }

    const projectInfo = parseGitlabRemote(remoteUrl);
    if (!projectInfo) {
      vscode.window.showErrorMessage(`Could not parse GitLab project from remote URL: ${remoteUrl}`);
      return;
    }

    const token = await getGitlabToken(this._context, true);
    if (!token) {
      vscode.window.showErrorMessage('GitLab Personal Access Token is required to create a Merge Request.');
      return;
    }

    let currentBranch = '';
    try {
      const { stdout: branchOut } = await execAsync('git rev-parse --abbrev-ref HEAD', getExecOptions(cwd));
      currentBranch = branchOut.trim();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed reading branch: ${e.message}`);
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Creating MR for ${currentBranch}...`,
        cancellable: false
      },
      async () => {
        try {
          // 1. Push current branch to origin
          await execAsync(`git push -u origin "${currentBranch}"`, getExecOptions(cwd));

          // 2. Resolve assignee & reviewer IDs if configured
          let assigneeId: number | undefined;
          if (data.assignee) {
            assigneeId = await getUserIdByUsername(projectInfo.host, token, data.assignee);
            if (!assigneeId) {
              vscode.window.showWarningMessage(`Could not resolve GitLab user ID for assignee '${data.assignee}'. MR will be created without this assignee.`);
            }
          }

          let reviewerId: number | undefined;
          if (data.reviewer) {
            reviewerId = await getUserIdByUsername(projectInfo.host, token, data.reviewer);
            if (!reviewerId) {
              vscode.window.showWarningMessage(`Could not resolve GitLab user ID for reviewer '${data.reviewer}'. MR will be created without this reviewer.`);
            }
          }

          let mrTitle = data.title;
          if (data.draft && !mrTitle.toLowerCase().startsWith('draft:') && !mrTitle.toLowerCase().startsWith('wip:')) {
            mrTitle = `Draft: ${mrTitle}`;
          }

          // 3. Prepare payload for GitLab API
          const payload: Record<string, any> = {
            source_branch: currentBranch,
            target_branch: data.target,
            title: mrTitle,
            description: data.description || '',
            squash: data.squash,
            remove_source_branch: data.removeBranch
          };

          if (assigneeId !== undefined) {
            payload.assignee_ids = [assigneeId];
          }
          if (reviewerId !== undefined) {
            payload.reviewer_ids = [reviewerId];
          }
          if (data.labels && data.labels.length > 0) {
            payload.labels = data.labels.join(',');
          }

          // 4. Send request to GitLab REST API
          const endpoint = `${projectInfo.host}/api/v4/projects/${encodeURIComponent(projectInfo.projectPath)}/merge_requests`;
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'PRIVATE-TOKEN': token
            },
            body: JSON.stringify(payload)
          });

          const resData = (await res.json()) as any;

          if (!res.ok) {
            const errorMsg = Array.isArray(resData.message)
              ? resData.message.join(', ')
              : (resData.message || resData.error || res.statusText);
            throw new Error(`GitLab API error (${res.status}): ${typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg}`);
          }

          if (data.openInWeb && resData.web_url) {
            vscode.env.openExternal(vscode.Uri.parse(resData.web_url));
          }

          vscode.window.showInformationMessage(`Merge Request created successfully!\n${resData.web_url || ''}`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed creating MR: ${err.message}`);
        }
      }
    );
  }

  private async submitTag(data: { tagName: string; createFrom: string; message: string }) {
    const cwd = await resolveGitRepoRoot();
    if (!cwd) {
      return;
    }

    const { tagName, createFrom, message: tagMessage } = data;
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
            await execAsync('git fetch origin --tags --force', getExecOptions(cwd));
          } catch {
            // ignore if offline
          }

          // Resolve to origin/<createFrom> if it exists on origin
          let targetRef = createFrom;
          try {
            await execAsync(`git rev-parse --verify "origin/${createFrom}"`, getExecOptions(cwd));
            targetRef = `origin/${createFrom}`;
          } catch {
            targetRef = createFrom;
          }

          // 1. Create tag locally pointing to targetRef
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
}

function getMainSidebarHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background, var(--vscode-editor-background));
      padding: 12px;
      margin: 0;
      box-sizing: border-box;
    }
    .action-buttons {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 12px;
    }
    .action-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      text-align: left;
      font-family: inherit;
    }
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .action-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .divider {
      height: 1px;
      background: var(--vscode-panel-border, #3c3c3c);
      margin-bottom: 14px;
    }
    .field {
      margin-bottom: 12px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 4px;
      font-size: 12px;
    }
    input[type="text"], textarea, select {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 2px;
      font-family: inherit;
      font-size: inherit;
    }
    input[type="text"]:focus, textarea:focus, select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    textarea {
      resize: vertical;
      min-height: 60px;
    }
    .badge {
      display: inline-block;
      padding: 2px 6px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 4px;
      font-size: 11px;
    }
    .checkbox-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin: 12px 0;
    }
    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: normal;
      cursor: pointer;
      font-size: 12px;
    }
    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }
    button.primary, button.secondary {
      padding: 7px 12px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
    }
    button.primary {
      flex: 1;
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
    .recent-tags {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 6px;
    }
    .recent-tags-title {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-right: 2px;
    }
    .tag-pill {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border: 1px solid transparent;
      border-radius: 12px;
      padding: 1px 7px;
      font-size: 11px;
      cursor: pointer;
      line-height: 1.4;
    }
    .tag-pill:hover {
      opacity: 0.8;
      border-color: var(--vscode-focusBorder);
    }
    .help-text {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      margin-top: 4px;
    }
    .empty-state, .loading-state {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
      padding: 24px 8px;
    }
    .form-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
  </style>
</head>
<body>
  <div class="action-buttons">
    <button id="btnMr" class="action-btn" onclick="selectTab('mr')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.5 5.396l2.323-2.323a.75.75 0 0 1 1.06 1.06l-2.853 2.854a.75.75 0 0 1-1.06 0L6.116 4.134a.75.75 0 1 1 1.06-1.061Z"/>
      </svg>
      Create Merge Request
    </button>
    <button id="btnTag" class="action-btn" onclick="selectTab('tag')">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.75 1.75 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25v5.025ZM6 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>
      </svg>
      Create Tag
    </button>
  </div>
  <div class="divider"></div>
  <div id="formContainer">
    <div class="empty-state">Select an action above to get started.</div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function selectTab(tab) {
      document.getElementById('btnMr').classList.toggle('active', tab === 'mr');
      document.getElementById('btnTag').classList.toggle('active', tab === 'tag');
      document.getElementById('formContainer').innerHTML = '<div class="loading-state">Loading ' + (tab === 'mr' ? 'Merge Request' : 'Tag') + ' details...</div>';
      vscode.postMessage({ command: tab === 'mr' ? 'loadMr' : 'loadTag' });
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'render') {
        document.getElementById('btnMr').classList.toggle('active', msg.tab === 'mr');
        document.getElementById('btnTag').classList.toggle('active', msg.tab === 'tag');
        document.getElementById('formContainer').innerHTML = msg.html;
        bindEvents(msg.tab);
      } else if (msg.command === 'reset') {
        document.getElementById('btnMr').classList.remove('active');
        document.getElementById('btnTag').classList.remove('active');
        document.getElementById('formContainer').innerHTML = '<div class="empty-state">' + (msg.message || 'Select an action above to get started.') + '</div>';
      }
    });

    function bindEvents(tab) {
      if (tab === 'mr') {
        const form = document.getElementById('mrForm');
        if (form) {
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            const labelsVal = document.getElementById('labels').value.trim();
            vscode.postMessage({
              command: 'submitMr',
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
        }
      } else if (tab === 'tag') {
        document.querySelectorAll('.tag-pill').forEach(btn => {
          btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-tag');
            const input = document.getElementById('tagName');
            if (input && val) {
              input.value = val;
              input.focus();
              input.select();
            }
          });
        });
        const cancelBtn = document.getElementById('cancelTagBtn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
          });
        }
        const form = document.getElementById('tagForm');
        if (form) {
          form.addEventListener('submit', (e) => {
            e.preventDefault();
            vscode.postMessage({
              command: 'submitTag',
              data: {
                tagName: document.getElementById('tagName').value.trim(),
                createFrom: document.getElementById('createFrom').value,
                message: document.getElementById('message').value
              }
            });
          });
        }
      }
    }
  </script>
</body>
</html>`;
}

function getMrFormHtml(init: {
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
}): string {
  const targetOptions = init.targetBranches.map(t =>
    `<option value="${t}" ${t === init.defaultTarget ? 'selected' : ''}>${t}</option>`
  ).join('');

  const assigneeOptions = init.assignees.map(a =>
    `<option value="${a}" ${a === init.defaultAssignee ? 'selected' : ''}>${a}</option>`
  ).join('');

  const reviewerOptions = init.reviewers.map(r =>
    `<option value="${r}" ${r === init.defaultReviewer ? 'selected' : ''}>${r}</option>`
  ).join('');

  return `
    <div class="form-title">
      <span>New Merge Request</span>
      <span class="badge">${init.branch}</span>
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
        <textarea id="description" rows="3"></textarea>
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

      <div class="button-group">
        <button type="submit" class="primary">Create Merge Request</button>
      </div>
    </form>
  `;
}

function getTagFormHtml(init: {
  currentBranch: string;
  branches: string[];
  latestTags: string[];
}): string {
  const branchOptions = init.branches.map(b =>
    `<option value="${b}" ${b === init.currentBranch ? 'selected' : ''}>${b}</option>`
  ).join('');

  const recentTagsHtml = init.latestTags && init.latestTags.length > 0 ? `
    <div class="recent-tags">
      <span class="recent-tags-title">Recent tags:</span>
      ${init.latestTags.map(t => `<button type="button" class="tag-pill" data-tag="${t.replace(/"/g, '&quot;')}">${t}</button>`).join('')}
    </div>
  ` : '';

  return `
    <div class="form-title">
      <span>New Tag</span>
    </div>
    <form id="tagForm">
      <div class="field">
        <label for="tagName">Tag name *</label>
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
        <textarea id="message" rows="3"></textarea>
        <div class="help-text">Optional tag message (leave blank for lightweight tag)</div>
      </div>

      <div class="button-group">
        <button type="submit" class="primary">Create Tag</button>
        <button type="button" id="cancelTagBtn" class="secondary">Cancel</button>
      </div>
    </form>
  `;
}
