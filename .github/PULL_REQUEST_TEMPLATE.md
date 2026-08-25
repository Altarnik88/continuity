## Summary

What changed, in one short paragraph.

## How to verify

- [ ] `npm ci --ignore-scripts` then `npm run check` (or name the subset you ran and why)
- [ ] Docs match the code (truth axes, Node 22/24, no host-Task spawn by Node)
- [ ] No secrets, personal data, raw logs, or private absolute paths

## Inventory

- [ ] New **root** files are listed in `scripts/package-inventory.mjs` (`REPO_METADATA_EXACT`)
- [ ] New pack/release files also update `DISTRIBUTABLE_FILES`, `package.json` `files`, and PKG-015
- [ ] `.github/`-only files do not need `REPO_METADATA_EXACT`

## Notes

CI pins Actions by full commit SHA. Do not switch them to floating tags.
