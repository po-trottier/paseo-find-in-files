Find in Files adds a Search tab beside Files and Changes in the Explorer pane. Search workspace files and preview a match in a read-only tab.

The plugin builds a content index in the background. The status row shows its progress and offers a Rebuild index button. Searches use a direct scan before the index is ready. The plugin watches files for changes and keeps the index in memory until a plugin restart.

Automatic indexing stays off for home directories and file system roots until you select Build index. The file walker excludes OneDrive cloud roots unless the workspace itself is inside one.

Use literal text or a regular expression. Match case, match whole words, and use include or exclude globs to limit files. The file walker respects nested `.gitignore` and `.ignore` files. It does not follow symbolic links. Query options and the preview target remain in each tab after a reload.

The plugin requires Paseo 0.14.0 or later. Search runs inside the plugin and requires no external search program or setup step. The daemon supports Windows, macOS, and Linux. The client uses the Paseo theme and supports compact layouts.

Search reads files on the daemon machine. Results and preview text go to the connected Paseo client, not an agent provider. Search and preview skip files above 1 MiB and binary files. Small remote placeholder files can still download when read. Each search stops at 2,000 matches and also limits total result size. Match verification stops after 15 seconds.

The index has a memory limit. A partial index checks files that it does not contain directly. Results arrive together after the search, not as a stream.

Open in VS Code uses the editor on the daemon machine. VS Code must be installed on that machine. Result clicks cannot open Paseo's own file tab yet. See [Paseo pull request #7318](https://github.com/getpaseo/paseo/pull/7318).
