# @dashboard/announcements

Dashboard-wide pop-up announcement system -- the content shown to everyone on dashboard open/refresh (see `packages/shell/public/app.js`'s `maybeShowAnnouncements()`), managed through this page's own admin list. Any signed-in user may add an announcement; editing, archiving, or deleting one is restricted to its original creator or the dashboard admin (outright deletion is narrower still -- admin only, even for the creator).

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Renders the announcement list/management table, plus the Add/Edit modal and the Acknowledgements modal.
- `server.js` -- Express router mounted by the shell at `/api/announcements`.
- `db.js` -- this page's own persistent data, a `node:sqlite` (`DatabaseSync`) file at `data.db` with two tables: `announcements` and `acknowledgements`. Needs Node >=22.5.

## Who can do what

- **Add** -- anyone signed in, by request.
- **Edit / Archive (retire)** -- the announcement's creator, or the dashboard admin (`isOwnerOrAdmin()`, checked server-side on every write, not just reflected client-side).
- **Delete outright** -- dashboard admin only, even for the creator of that announcement. By request: "the creator can Archive but not delete."
- **View who's acknowledged** (`GET /:id/acknowledgements`) -- open to everyone who can reach this page, not gated by ownership.
- **Acknowledge** -- anyone the announcement targets, regardless of who manages it.

"Archived" (retiring) just stops an announcement from matching/appearing -- it stays fully editable and can be restored (unretired) any time. There's no separate audit trail beyond `updated_by_*`/`retired_by_*` columns.

## Targeting and the active-announcement query

An announcement with no `targets` shows to literally everyone. A targeted one is scoped to one or more teams (`serviceDesk` / `professionalServices` / `leadership`), matched against the viewer's real Autotask `ResourceRoleDepartments` membership (`fetchServiceDeskAndProfessionalServicesMembership()`). This membership lookup is hot -- it runs on every dashboard page open/refresh for every signed-in user via `GET /active` -- so it's cached in-process for 5 minutes (`getCachedMembership()`), separately from `@dashboard/autotask-client`'s own fresh-per-request version used by other pages.

The matcher (`targetMatches()` in `db.js`) is written to be extensible: today only `type: 'team'` exists, but a later non-team criterion is meant to be a new case there, not a schema or wire-format change (`targets_json` is a plain JSON array of `{type, value}` objects).

An announcement also respects an optional `startAt`/`endAt` window, and (if `ackRequired`) stops showing to a given person the moment they've acknowledged it -- but keeps showing to everyone else until they do too.

## Acknowledgements and the "hasn't acknowledged yet" list

Acknowledging is idempotent (`INSERT OR IGNORE`, backed by a `UNIQUE(announcement_id, acknowledged_by_email)` constraint) -- a double-click or a race between two tabs is a harmless no-op.

The admin-facing Ack's view shows both who *has* acknowledged and, separately, who's actually eligible to see the announcement but hasn't yet (`fetchEligibleUsers()` in `server.js`): every active, non-API-user Autotask resource if the announcement is untargeted, or just the members of its targeted team(s) otherwise. `ANNOUNCEMENT_ACK_IGNORE` in `.env` (comma-separated exact Entra display names, same format as `ADMIN_FULL_ACCESS`) lets specific people be left off both display lists entirely -- it does not stop their own pop-up still asking them to acknowledge.

## Screenshots

An announcement can carry one optional pasted screenshot, stored as a `data:` URL directly in the `image_data_url` column -- resized/recompressed client-side first (capped to 1400px on its longest side, JPEG at quality 0.82) via the same `resizeImageDataUrl()` round-trip `@dashboard/updates` uses, so this never lands in the database as a raw multi-MB capture. There's no separate file storage and no server-side size cap beyond Express's own `10mb` JSON body limit (not actually raised here -- this page uses the default limit, so a very large pasted image could still be rejected at the HTTP layer before `server.js` ever sees it).
