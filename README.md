# Ambient IT Dashboard

Small internal multi-page dashboard, backed by the Autotask API. It's an npm workspaces monorepo: each sidebar page is its own package under `packages/`, discovered automatically by the shell at startup. Different people can work on different pages in isolation and merge via normal git branches/PRs, without touching shared code.

## Structure

```
packages/
  shell/               the Express app + sidebar frontend (the "host")
  autotask-client/      shared library: Autotask API client + name-resolution caches
  completed-tickets/    a dashboard page (frontend + its own backend router)
```

- **shell** serves the sidebar shell UI, discovers page packages, and mounts each page's router at `/api/<page-id>`.
- **autotask-client** is shared plumbing (`getClient()`, `resolveResourceName()`, `resolveCompanyName()`) that any page needing Autotask data can depend on, so connection/rate-limit/name-resolution logic isn't duplicated per page.
- Each page package (e.g. **completed-tickets**) owns its own frontend module and, optionally, its own Express router - a self-contained unit one person can build and review independently.

## Pages

- **Completed Tickets** (`packages/completed-tickets`) - pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it. Excludes tickets with issue type "Monitoring Alert".

### Adding a new page

1. Create a new folder under `packages/`, e.g. `packages/my-page/`.
2. Add a `package.json` with a `dashboardPage` field:
   ```json
   {
     "name": "@dashboard/my-page",
     "private": true,
     "dashboardPage": {
       "id": "my-page",
       "label": "My Page",
       "client": "client.js",
       "server": "server.js"
     }
   }
   ```
3. Write `client.js` exporting `id`, `label`, and `mount(container)` (renders your UI into the given DOM element).
4. Optionally write `server.js` exporting an Express `Router` - the shell mounts it at `/api/my-page`.
5. If you need Autotask data, add `"@dashboard/autotask-client": "*"` to your dependencies and `require('@dashboard/autotask-client')`.
6. Run `npm install` from the repo root so the new workspace package gets linked.

That's it - no shell code changes needed. The sidebar and routing pick up the new page automatically on next server start.

## Setup

1. Install dependencies. The `autotask-node` package (used by `@dashboard/autotask-client`) lives on GitHub Packages, so you need a GitHub personal access token with `read:packages` scope for the `wyre-technology` org:

   ```powershell
   $env:NPM_GITHUB_TOKEN = "ghp_your_token_here"
   npm install
   ```

   This installs and links every package in `packages/` in one go (npm workspaces).

2. Copy `.env.example` to `.env` (at the repo root) and fill in your Autotask API credentials:

   ```
   AUTOTASK_USERNAME=...
   AUTOTASK_SECRET=...
   AUTOTASK_INTEGRATION_CODE=...
   ```

3. Start the server:

   ```powershell
   npm start
   ```

4. Open http://localhost:3000

## Notes

- "Completed" (for the Completed Tickets page) means Autotask ticket status ID 5 (Complete).
- Resource and company names are resolved via the Autotask API and cached in memory for the life of the server process.
- `GET /api/completed-tickets?date=YYYY-MM-DD` returns the raw JSON if you want to consume it elsewhere.