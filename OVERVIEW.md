Find in Files adds a Search tab beside Files and Changes in the Explorer pane. Search workspace files and preview a match in a read-only tab.

Use literal text or a regular expression. Match case, match whole words, and use include or exclude globs to limit files. Search respects `.gitignore`. Query options and the preview target remain in each tab after a reload.

The plugin requires Paseo 0.14.0 or later and `rg` (ripgrep) on the daemon PATH. The daemon supports Windows, macOS, and Linux. The client uses the Paseo theme and supports compact layouts.

Search reads files on the daemon machine. Results and preview text go to the connected Paseo client, not an agent provider. Each search stops at 2,000 matches. Search omits lines above 16 KiB and also limits total result size. Preview files have a 2 MiB limit. Binary files do not render.

On Paseo 0.14.0, results arrive together after the search, not as a stream.

Open in VS Code uses the editor on the daemon machine. VS Code must be installed on that machine. Result clicks cannot open Paseo's own file tab yet. See [Paseo pull request #7318](https://github.com/getpaseo/paseo/pull/7318).
