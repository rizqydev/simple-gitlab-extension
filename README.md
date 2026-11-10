# Simple GitLab Extension

VS Code extension to quickly create GitLab Merge Requests using the official `glab` CLI with an interactive form.

## Features

- **Webview Form**: Pre-fills title from latest commit message or branch name.
- **Dropdown Selectors**: Configurable list of assignees and reviewers per project.
- **Direct CLI Execution**: Automates `git push -u origin <branch>` and `glab mr create`.
- **Merge Options**: Easily toggle Draft (WIP), squash commits, branch deletion, and auto-opening in browser.

## Requirements

1. [Git](https://git-scm.com/) installed and repository initialized.
2. [GitLab CLI (`glab`)](https://gitlab.com/gitlab-org/cli) installed and authenticated:
   ```bash
   winget install glab
   glab auth login
   ```

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
    "your_gitlab_username",
  ],
  "gitlabMr.defaultAssignee": "your_gitlab_username",
  "gitlabMr.reviewers": [
    "your_teamate_username1",
    "your_teamate_username2",
  ],
  "gitlabMr.defaultReviewer": "your_teamate_username1",
  "gitlabMr.labels": [],
  "gitlabMr.squash": false,
  "gitlabMr.removeBranch": false,
  "gitlabMr.openInWeb": true
}
```

## Usage

### Create Merge Request
1. Open a Git project on a feature branch.
2. Open the Command Palette (`Ctrl+Shift+P`) and run:
   ```
   SGE: Create Merge Request
   ```
   *(Or click the pull request icon in the Source Control panel header).*
3. Fill in or review the details and click **Create Merge Request**.

### Create New Tag
1. Open the Command Palette (`Ctrl+Shift+P`) and run:
   ```
   SGE: Create Tag
   ```
   *(Or click the tag icon in the Source Control panel header).*
2. Enter the **Tag name**, choose the branch in **Create from** (defaults to the active branch), and optionally enter a **Message**.
3. Click **Create tag**. A confirmation prompt will ask if you want to push the newly created tag to `origin`.

## License

[MIT](LICENSE)
