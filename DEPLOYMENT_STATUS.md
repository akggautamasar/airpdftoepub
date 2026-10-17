# Deployment status — 2026-10-17

## Resources actually created on connected Cloudflare account

- Account: `985f4c46b5562cddb814b08bc654e30a`
- D1 database: `pdfepub-db` (`3803a7bf-5310-4bff-a7d7-edc5732195e8`), region APAC. Initial tables and indexes applied successfully.
- Queue: `pdfepub-jobs` (`8f6ec35d8b234d77bcb7e45e3be191e5`).
- Worker: **not deployed**, because required R2 binding cannot be created yet.
- R2 bucket: **not created**. Cloudflare API returned error `10042: Please enable R2 through the Cloudflare Dashboard.`
- Render compute: **not deployed**. Current code requires the private R2 bucket and scoped object credentials. Deploying now would produce an unusable compute service.
- GitHub: connected account has existing repos, but no dedicated pdfepub-api repository. No existing projects modified.

## One unavoidable account action

Open Cloudflare Dashboard > Storage & databases > R2 and enable R2. Review whether a billing method is required and account overage terms. This assistant did not enable any paid subscriptions or billing.

Once R2 is enabled, rerun deployment to create `pdfepub-files`, install Worker bindings and shared secret, publish the source to a separate GitHub repository or safe deployment branch, create Render free service, and verify a full PDF -> EPUB job. **The system is not live yet.**

Source pack has the real D1 ID set in `cloudflare/wrangler.jsonc`. No credentials included.
