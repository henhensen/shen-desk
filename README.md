# shen-desk

A Claude Code mod built for one Obsidian vault. It adds:

- **Desk pane** (right side): a foldable Tasks list, open tasks from every project's `Tasks/` folder sorted by due date (orange within 7 days, red when late), and a foldable Sessions list showing which Claude Code sessions are working or waiting. `/desk` toggles it.
- **Token in / out** in the prompt footer, beside the model name.
- **Vault guard**: blocks `git checkout` / `git switch` in the vault's main folder (worktrees are fine), blocks writes to `04_Methodology/` (`/desk-unlock` opens it for 10 minutes), and blocks em dashes or spaced double dashes in vault notes.
- **Closeout nudge**: a toast when a project's files change but its journal was not written; `/closeout` asks Claude to do the closeout.

## Install

In a terminal:

```
/plugin install shen-desk --marketplace henhensen/shen-desk
```

In the Claude desktop app: click **+** next to the prompt box, choose **Plugins**, **Add marketplace**, enter `henhensen/shen-desk`, then add the plugin.

## Using it on your own vault

The vault path and folder names are hard coded near the top of `hooks/register.tsx` (`VAULT`, `TASK_ROOTS`). Change them to your own before relying on the pane or the guard. Session status files live in `~/.claude/shen-desk/`.

## Remove

Uninstall the plugin and delete `~/.claude/shen-desk/`.
