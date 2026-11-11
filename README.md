# Simple GitLab Extension

VS Code extension to quickly create GitLab Merge Requests and Tags directly from the sidebar using native GitLab REST API and interactive forms.

## Features

- **Activity Bar Sidebar**: Dedicated GitLab tab with action buttons and inline forms.
- **Merge Request Form**: Pre-fills title from latest commit message or branch name, provides target branch dropdown, assignee/reviewer dropdowns, draft (WIP), squash, and delete source branch toggles.
- **Native GitLab API**: Direct API integration—no `glab` CLI or external tools required.
- **Tag Creation**: GitLab-style UI with remote tag auto-fetching, 5 recent tags quick-fill buttons, message support, and push confirmation.
- **Self-Hosted & GitLab.com**: Automatically resolves host and project path from `origin` remote.

## Requirements

1. [Git](https://git-scm.com/) installed and repository initialized.
2. GitLab Personal Access Token (PAT) with `api` scope:
   - Run command: `SGE: Set GitLab Personal Access Token` (or click the key icon in the sidebar header).

## Installation

### From VSIX
1. Download or package the `.vsix` file:
   ```bash
   npx @vscode/vsce package --allow-missing-repository
   ```
2. Install in VS Code:
   ```bash
   code --install-extension simple-gitlab-extension-0.1.0.vsix
   ```

## Configuration

Configure options globally in VS Code Settings (`Ctrl+,`) or per workspace in `.vscode/settings.json`:

```json
{
  "gitlabMr.target": "development",
  "gitlabMr.assignees": [
    "your_gitlab_username"
  ],
  "gitlabMr.defaultAssignee": "your_gitlab_username",
  "gitlabMr.reviewers": [
    "your_teammate_username1",
    "your_teammate_username2"
  ],
  "gitlabMr.defaultReviewer": "your_teammate_username1",
  "gitlabMr.labels": [],
  "gitlabMr.squash": false,
  "gitlabMr.removeBranch": false,
  "gitlabMr.openInWeb": true
}
```

## Usage

### GitLab Activity Bar
Click the **GitLab** icon in the Activity Bar on the left. You will see:
- **Create Merge Request** button
- **Create Tag** button

Clicking either button will load its form directly inline below the buttons.

### Create Merge Request
1. Open a Git project on a feature branch.
2. Click **Create Merge Request** in the sidebar (or run `SGE: Create Merge Request`).
3. Fill in details and click **Create Merge Request**.
   - If you haven't set your Personal Access Token yet, you will be prompted to enter it.

### Create New Tag
1. Click **Create Tag** in the sidebar (or run `SGE: Create Tag`).
2. Enter the **Tag name** (or click one of the recent tag pills to auto-fill), select **Create from**, and optionally enter a **Message**.
3. Click **Create Tag**. A prompt will ask if you want to push the newly created tag to `origin`.

## License

[MIT](LICENSE)
