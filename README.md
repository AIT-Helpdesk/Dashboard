# Autotask Completed-Tickets Dashboard

Small internal web app: pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it.

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
