# Find in Files

Search workspace content from a Search tab beside Files and Changes in Paseo's Explorer pane.

## Requirements

- Paseo desktop and daemon 0.14.0 or later.
- `rg` (ripgrep) on the daemon PATH.
- VS Code on the daemon machine for Open in VS Code.

The daemon supports Windows, macOS, and Linux. The client uses React Native controls and supports compact layouts.

## Install

Run these commands from this repository:

```text
npm install
npm run typecheck
npm test
paseo plugin install C:/Users/ptrottier/source/paseo-find-in-files
```

Open the Command Center and select **Find in files** in a workspace. The command opens the Explorer Search tab.

After a source change, run `paseo plugin reload find-in-files`. Do not restart Paseo.

## Search and preview

Enter a query. Search starts after a 250 ms delay. A new edit cancels the previous search.

Use Match case, Whole word, or Regex to change the search. Expand the file filters to enter an include or exclude glob. Each field accepts one ripgrep glob. Use braces for alternatives, such as `*.{ts,tsx}`.

Results appear below collapsible file headers. Select a match to reuse the read-only preview tab. Select **Open in VS Code** to open that file at its line and column on the daemon machine.

Query options and the preview target remain in tab state after a reload. The plugin does not use plugin settings documents.

## Data and limits

Search runs `rg --json` without a shell and respects `.gitignore`. Searches stop at 2,000 matches. The daemon resolves the workspace directory through the Paseo SDK.

Search omits lines above 16 KiB. The daemon limits each JSON record to 1 MiB and estimated result data to 2 MiB. Narrow the query or the file glob when the truncation notice appears.

Paseo 0.14.0 does not expose plugin subscriptions in its SDK. This plugin uses one search RPC and returns the capped results together. A new request with the same search ID cancels the previous process.

Preview reads at most 2 MiB. Binary files do not render. Preview and editor actions reject paths outside the workspace, including symlink escapes.

Search results and preview text go to the connected Paseo client. The plugin does not send them to an agent provider.

Result clicks cannot open Paseo's own file tab yet. The plugin uses its preview tab until [Paseo #7318](https://github.com/getpaseo/paseo/pull/7318) provides that API.

Open in VS Code uses a `vscode://file/` URL. It works when the daemon runs on the machine where VS Code is installed. A remote client does not open its local editor.

## Development checks

```text
npm run typecheck
npm test
paseo plugin ls
paseo plugin logs find-in-files
```

The tests cover ripgrep JSON, UTF-8 match offsets, path containment, file reads, and editor URL arguments. They do not launch an editor.

Paseo plugin contracts: [plugin reference](https://paseo.sh/docs/plugins/reference).
