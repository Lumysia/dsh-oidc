# Third-party notices

## DeepSeek Harness (MIT)

`src/client/styles.ts` adapts the launcher geometry of `@deepseek-ai/dsh-client-ui-settings-account` (`AccountMenu.module.css`, `AccountAvatar.module.css`), and `src/client/AccountMenu.tsx` copies that package's `LogoutIcon` glyph path, so the sidebar account button matches DSH's own. DeepSeek Harness is distributed under the MIT License; its copyright notice: Copyright (c) 2026 DeepSeek. No other DeepSeek or third-party source was copied or substantially adapted into this repository.

## Production dependencies and peers

The package directly depends on `@deepseek-ai/schemastery` and `openid-client`, and composes with the DeepSeek peers listed in `package.json`. The installed production dependency graph also contains `@deepseek-ai/cosmokit`, `@standard-schema/spec`, `oauth4webapi`, and `jose`. Each of those named packages is distributed under the MIT License according to its installed package metadata.

Exact resolved versions and integrity hashes are recorded in `package-lock.json`. This notice does not claim that every package in the complete development-tool lock tree is MIT-licensed; development tools and their transitive dependencies retain their own published license terms and must be reviewed separately for release provenance.
