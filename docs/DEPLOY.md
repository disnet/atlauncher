# Deploying the demo to Cloudflare

The demo needs an origin per part, just as it does locally:

| Part | Worker | URL |
|---|---|---|
| Shell (Phase 1 FedCM IdP) | `atworkplace-shell` | `https://atworkplace-shell.<subdomain>.workers.dev` |
| Demo app | `atworkplace-app` | `https://atworkplace-app.<subdomain>.workers.dev` |
| Mock PDS (Phase 2 FedCM IdP) | `atworkplace-pds` | `https://atworkplace-pds.<subdomain>.workers.dev/login` |
| Mock apps | `atworkplace-skyreader`, `-reams`, `-roomy` | `https://atworkplace-skyreader.<subdomain>.workers.dev` and so on |

`<subdomain>` is the account's workers.dev subdomain. `workers.dev` is on
the Public Suffix List, so each Worker is its own site: the framed app is
cross-site from the shell and gets partitioned storage, as on localhost.

Each part is a Worker with static assets. The Worker runs first on every
request (`run_worker_first`), so the same handlers as the local Node servers
answer the FedCM, OAuth, relay and API routes and set the CSP headers on
pages. They share one D1 database for state that has to outlive a
single request: the shell's account lists, the popup relay, and the mock
PDS's codes and tokens.

## Deploy

Needs a Cloudflare account with a workers.dev subdomain, and either
`npx wrangler login` or a `CLOUDFLARE_API_TOKEN` that can edit Workers
scripts and D1.

```sh
npm install
CLOUDFLARE_ACCOUNT_ID=<account id> npm run deploy
```

The script (`deploy/deploy.ts`):

1. Looks up the account's workers.dev subdomain to work out the origins.
2. Creates the D1 database `atworkplace` if it doesn't exist, and applies
   `deploy/schema.sql` (idempotent).
3. Builds `deploy/out/<part>/`: the browser bundles with the deployed origins
   baked in, the Worker bundle, and a `wrangler.json` with the D1 binding.
4. Runs `wrangler deploy` for each part, then prints the URLs.

Run it again to redeploy. Options, as environment variables:

- `ATWORKPLACE_PREFIX`: names the Workers `<prefix>-shell` and so on, and the
  database `<prefix>` (default `atworkplace`).
- `SHELL_ORIGIN`, `APP_ORIGIN`, `PDS_ORIGIN`, `SKYREADER_ORIGIN`,
  `REAMS_ORIGIN`, `ROOMY_ORIGIN`: use these origins instead of workers.dev,
  for custom domains. Add the routes in Cloudflare yourself.

## From GitHub Actions

`.github/workflows/deploy.yml` runs the typecheck and tests on every push
and pull request. On pushes to `main` (or a manual run of the workflow) it
then runs `npm run deploy` and the HTTP tests below against the deployment.

It needs two repository secrets, under Settings → Secrets and variables →
Actions:

- `CLOUDFLARE_API_TOKEN`: a token made from the "Edit Cloudflare Workers"
  template, with D1: Edit added.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to.

Until both are set, the deploy job is skipped with a warning. The tests it
runs after deploying add a test account (`did:plc:testalice`) to a fresh
shell session in the deployed D1 each time; nobody sees it, since sessions
are keyed by a cookie.

## Check it

```sh
ATWORKPLACE_ORIGINS='{"shell":"https://…","app":"https://…","pds":"https://…"}' \
  npx tsx --test test/fedcm-idps.test.ts
```

runs the same HTTP tests as `npm test` against the deployment. The tests
also start the local servers, which they then ignore.

`npm run deploy:preview` runs the deploy build locally under `wrangler dev`
with a local D1, on ports 8780 (shell), 8781 (app, on `127.0.0.1`), 8782
(mock PDS) and 8783 to 8785 (mock apps), so the Workers can be checked
before deploying.

## Differences from local

- **OAuth client:** locally the app is an atproto loopback client. Deployed,
  its `client_id` is `https://<app>/oauth-client-metadata.json`, which the
  app Worker serves, so the auth server fetches it.
- **State:** D1 instead of memory and `.data/shell.json`.
- **Origins:** the shell and the mock PDS are cross-site from each other too.
  Locally they share `localhost`.
