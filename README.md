# Ambient IT Dashboard

Small internal multi-page dashboard, backed by the Autotask API. The frontend is a sidebar-navigated single-page app: pages live under `public/pages/`, and the sidebar lists whatever's registered.

## Pages

- **Completed Tickets** - pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it. Excludes tickets with issue type "Monitoring Alert".

### Adding a new page

1. Create `public/pages/your-page.js` exporting `id`, `label`, and `mount(container)` (mount renders into the given DOM element).
2. Add an entry to `public/pages-registry.js` pointing at it.
3. Add any backend endpoints it needs to `server.js`.

The sidebar and routing (URL hash-based) pick it up automatically - no other wiring needed.

## Setup

1. Install dependencies. The `autotask-node` package lives on GitHub Packages, so you need a GitHub personal access token with `read:packages` scope for the `wyre-technology` org:

   ```powershell
   $env:NPM_GITHUB_TOKEN = "ghp_your_token_here"
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Autotask API credentials:

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

- "Completed" means Autotask ticket status ID 5 (Complete).
- Date filtering uses the ticket's `completedDate` field, compared against UTC calendar-day boundaries for the selected date.
- Resource and company names are resolved via the Autotask API and cached in memory for the life of the server process.
- `GET /api/completed-tickets?date=YYYY-MM-DD` returns the raw JSON if you want to consume it elsewhere.