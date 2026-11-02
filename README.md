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

The status row shows index progress, completion time, and errors. Select **Rebuild index** to rebuild it. Searches use a direct scan before the index is ready. The results identify a direct scan.

Automatic indexing stays off for the user's home directory and file system roots. Select **Build index** to start it explicitly. Searches in these folders still use a direct scan. A restored query stays paused until you press Enter or edit it.

Results appear below collapsible file headers. Select a match to reuse the read-only preview tab. Select **Open in VS Code** to open that file at its line and column on the daemon machine.

Query options and the preview target remain in tab state after a reload. The plugin does not use plugin settings documents.

## Data and limits

The daemon resolves the workspace directory through the Paseo SDK. The file walker respects nested `.gitignore` and `.ignore` files. It always excludes `.git` directories and does not follow symbolic links.

The walker includes hidden files and directories unless ignore rules exclude them. It skips nested repositories and worktrees that contain a `.git` file or directory.

The walker excludes cloud roots from the Windows `OneDrive`, `OneDriveCommercial`, and `OneDriveConsumer` environment variables. This guard does not apply when the workspace itself is inside that cloud root. For such a workspace, automatic indexing stays off, but a search or a Build index reads its files and can download them. Other small remote placeholder files can still download when read.

The index stores lowercase ASCII byte trigrams and file metadata in memory. Search intersects the required trigram lists, then checks candidate files with the actual matcher. Regex plans use only required literal text. A pattern with no safe trigrams scans all eligible files.

The plugin checks each file's size before it opens the file. Search, indexing, and preview skip files above 1 MiB. The plugin skips binary files.

Posting arrays share a 32-million-entry limit. The index marks itself partial when a memory limit prevents more entries. Search checks files that the partial index does not contain directly. The plugin does not save the index to disk. It rebuilds the index after a plugin restart.

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

Tests cover query plans, ignore rules, index updates, file size limits, exact match offsets, containment, and editor URL arguments. Tests do not launch an editor.

Paseo contracts: [plugin reference](https://paseo.sh/docs/plugins/reference).

## Icon attribution

The Match case, Whole word, and Regex icons come from [Visual Studio Code Codicons](https://github.com/microsoft/vscode-codicons). Microsoft licenses these icons under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). The plugin embeds their SVG paths and uses the Paseo theme for their color.
