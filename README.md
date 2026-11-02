# Find in Files

Search workspace content from the Search tab beside Files and Changes in Paseo's Explorer pane.

## Requirements

Paseo desktop and daemon 0.14.0 or later are required. Search uses Node inside the plugin. No external search program or setup step is required.

Open in VS Code requires VS Code on the daemon machine. The daemon supports Windows, macOS, and Linux. The client uses React Native controls and supports compact layouts.

## Install

Run these commands from this repository:

```text
npm install
npm run typecheck
npm test
paseo plugin install .
```

Open the Command Center and select **Find in files** in a workspace. The command opens the Explorer Search tab.

After a source change, run `paseo plugin reload find-in-files`. Do not restart Paseo.

## Search and preview

Enter a query. Search starts after a 250 ms delay. Enter starts a pending search immediately. Enter does not repeat an identical active or completed search. A new edit cancels the previous search.

Use Match case, Whole word, or Regex inside the query field to change the search. Select **File filters** below the field to show include and exclude inputs. Each field accepts one glob. Use braces for alternatives, such as `*.{ts,tsx}`.

The status row shows index progress, completion time, and errors. Counts cover all relevant index units, not only files inside a subfolder workspace. Select **Rebuild index** to rebuild them. Searches use a direct scan before the index is ready. The results identify a direct scan.

Automatic indexing stays off for the user's home directory, file system roots, and folders inside OneDrive. Select **Build index** to start it explicitly. Searches in these folders reuse available indexes and scan other files directly. A restored query stays paused until you press Enter or edit it.

Results appear below collapsible file headers. Select a match to reuse the read-only preview tab. Select **Open in VS Code** to open that file at its line and column on the daemon machine.

Preview keeps indentation and expands tabs to four-column stops. It colors syntax with the same engine as Paseo. The selected line and query match remain marked. Syntax uses at most 768 KiB of source and a 200 ms work budget. Larger files and lines with more than 256 syntax tokens remain plain text.

Query options and the preview target remain in tab state after a reload. The plugin settings screen controls the search shortcut. The preview uses the syntax theme from Paseo Settings > Appearance. The plugin reads it from Paseo's internal `@paseo:app-settings` storage on desktop and web, and checks it again each second. Native clients use Paseo's default theme (`one`).

The default shortcut is **Ctrl+Alt+Shift+F** on Windows and Linux, or **Command+Option+Shift+F** on macOS. Paseo 0.14 does not assign this chord. Its **Ctrl/Command+Shift+F** chord controls focus mode instead. Select the shortcut value in the plugin settings to capture a new chord. Select **Clear** to disable it.

The shortcut works only on web and desktop workspace routes. It stays inactive in detected terminals and modal dialogs. This detection is best effort. Native clients use the Command Center. The shortcut uses an internal route until Paseo provides a plugin shortcut API.

## Data and limits

The daemon resolves the workspace directory through the Paseo SDK. The file walker respects nested `.gitignore` and `.ignore` files. It always excludes `.git` directories and does not follow symbolic links.

The walker includes hidden files and directories unless ignore rules exclude them. Each repository or worktree root has one shared index. Workspaces inside the same root reuse that index and restrict results to their own folders.

A parent-folder search includes nested repositories and submodules. It excludes nested worktrees to prevent duplicate results. A workspace that points at a worktree searches that worktree separately. Each index applies its own ignore files and excludes events from child repositories.

The walker excludes cloud roots from the Windows `OneDrive`, `OneDriveCommercial`, and `OneDriveConsumer` environment variables. This guard does not apply when the workspace itself is inside that cloud root. For such a workspace, automatic indexing stays off, but a search or a Build index reads its files and can download them. Other small remote placeholder files can still download when read.

The index stores lowercase ASCII byte trigrams and file metadata in memory. Search intersects the required trigram lists, then checks candidate files with the actual matcher. Regex plans use only required literal text. A pattern with no safe trigrams scans all eligible files.

The plugin checks each file's size before it opens the file. Search, indexing, and preview skip files above 1 MiB. The plugin skips binary files.

Posting arrays share a 32-million-entry limit. The index marks itself partial when a memory limit prevents more entries. Search checks files that the partial index does not contain directly. The plugin does not save the index to disk. It rebuilds the index after a plugin restart.

Mounted Search tabs keep their index units available. The plugin can remove unused units when it reaches the directory limit.

Index metadata also has limits. A direct scan rejects more than 200,000 candidate files or 16 million path characters instead of exceeding its memory limit.

A recursive file watcher updates changed files and removes deleted files. The plugin rebuilds when old document entries exceed 25 percent. A watcher error marks the index stale. Rebuild the index after a stale status.

Search checks each line with JavaScript regular expressions. Whole word uses Unicode letter, number, and underscore boundaries. A worker isolates each search. Cancellation terminates that worker. A 15-second limit stops an expensive pattern and returns an error.

Each search returns at most 2,000 matches and limits the result data size. Narrow the query or file filters when the truncation notice appears. Paseo 0.14.0 returns the capped results together, not as a stream.

The truncation notice also appears if a file changes during its read or the plugin cannot read a candidate file.

Preview and editor actions reject paths outside the workspace, including symbolic link escapes. Search results and preview text go to the connected Paseo client. The plugin does not send them to an agent provider.

Result clicks cannot open Paseo's own file tab yet. The plugin uses its preview tab until [Paseo #7318](https://github.com/getpaseo/paseo/pull/7318) provides that API.

Open in VS Code uses a `vscode://file/` URL. It works when the daemon runs on the machine where VS Code is installed. A remote client does not open its local editor.

## Development checks

```text
npm run typecheck
npm test
paseo plugin ls
paseo plugin logs find-in-files
```

Tests cover query plans, ignore rules, shared repository units, file size limits, match offsets, containment, and editor URL arguments. They also cover Python syntax tokens, tabs, shortcut chords, and workspace routes. Tests do not launch an editor.

Paseo contracts: [plugin reference](https://paseo.sh/docs/plugins/reference).

## Icon attribution

The Match case, Whole word, and Regex icons come from [Visual Studio Code Codicons](https://github.com/microsoft/vscode-codicons). Microsoft licenses these icons under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The plugin embeds their SVG paths and uses the Paseo theme for their color.

## Syntax engine license

The plugin uses `@getpaseo/highlight` 0.14.0. The [Paseo 0.14.0 license](https://github.com/getpaseo/paseo/blob/v0.14.0/LICENSE) covers Paseo code under Apache-2.0. Third-party components retain their own licenses. The package includes an [MIT license for its Astro parser](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/highlight/src/astro/LICENSE).

