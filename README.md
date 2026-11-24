# Bookmark Sync Vault

This **private** repository is dedicated to the cross-browser bookmark sync extension.

- The extension writes a single file, , at the repository root.
- Conflict snapshots are stored under  automatically.
- Do not rename or delete files that the extension created; doing so is treated as a remote change.
- Never commit the GitHub token here. The token is stored only in the browser extension isolated storage.
