# Bookmark Sync Vault

This **private** repository is dedicated to the cross-browser bookmark sync extension.

- The extension writes one data file at the repository root: `bookmarks.json`.
- Conflict snapshots are written under `backups/` automatically.
- Do not rename or delete files created by the extension; such changes are treated as remote edits.
- Never commit the GitHub token here. It stays in the browser extension isolated storage only.
