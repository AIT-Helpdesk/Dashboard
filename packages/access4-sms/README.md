# SMS

A two-pane SMS inbox/CRM: a left-hand list of conversations (by phone
number) for a recent period, a right-hand detail pane with the full
message history, client/contact linking, per-message ticket association,
internal notes, and a reply-template system with fill-in `{{tags}}`.

Sends go out through Access4's SASBOSS SMS Gateway API. **Real inbound
receiving is not built yet** -- see "Why this page doesn't receive real
texts yet" below.

## Why our own database, not Access4's

Access4 is used ONLY for the actual act of sending (and, eventually,
receiving) an SMS. Every conversation, message, status, client/ticket
association, note, and template lives in this page's own SQLite database
(`data.db`) -- never re-derived from Access4's own history API. Access4's
documented `Get SMS List`/`Get SMS Report` endpoints return reply
*metadata* (who replied, when, which number) but no field for the reply's
actual text in any example in their own API guide -- irrelevant here,
since this page never depends on asking Access4 for history at all.

## Why this page doesn't receive real texts yet

Per direct instruction, this build is the full data model, backend, and
UI, with a real outbound send, but inbound capture is a manual stand-in
for now ("Log Inbound Message" on the compose bar -- type in what the
client said). Every inbound message goes through one function,
`recordInboundMessage()` in `db.js`; the manual button is its only caller
today, so wiring in a real capture mechanism later is a new caller of that
same function, not a UI/data-model change.

**The real mechanism, when it's built:** Access4's own `forwardToUrl`/
`forwardToUrlValue` fields (set per-send) push a reply straight to a URL
this server controls -- a real webhook, no mailbox/Microsoft Graph app
needed. Two things to resolve first:
- Production sits entirely behind this dashboard's Microsoft tenant SSO
  (`packages/shell/server.js`'s `app.use(requireAuth)`). A webhook route
  needs to be registered BEFORE that line (same place `/auth/*` lives)
  and secured with its own shared secret instead -- Access4's
  server-to-server POST can't do an interactive Microsoft login.
- The exact webhook payload shape is undocumented, and it's unconfirmed
  whether it fires for a genuinely unprompted first-contact text (vs only
  real replies to something this account sent) -- both need a real test
  once this part is actually built.

## Data model (`db.js`)

- `conversations` -- one row per phone number. `company_id`/`contact_id`
  are optional (a conversation can exist with no client link at all, e.g.
  a one-off text to a raw number -- link it later). `status` is a
  staff-chosen resolution label (New/Awaiting Reply/Replied -- SMS/
  Replied -- Email/Replied -- Phone Call/Ticket Logged/Escalated/No
  Action Needed/Opted Out/Closed); `has_unread` is a separate, auto-managed
  notification flag (set on any inbound message, cleared when the
  conversation is opened) -- kept apart from `status` on purpose.
  `do_not_contact` gates the compose box.
- `messages` -- one row per SMS, inbound or outbound. `ticket_number` is
  stored PER MESSAGE, not per conversation -- one phone number's history
  can span many separate issues over time. The "Copy from Previous
  Message" button (`GET /conversations/:id/previous-ticket`) fills the
  ticket field with whatever the most recent message on that same
  conversation had, a one-click carry-forward rather than retyping it.
  `is_logged_manually` marks a message entered via the manual inbound
  stand-in, keeping history honest about provenance.
- `notes` -- internal staff commentary per conversation, separate from the
  real SMS thread.
- `templates` -- saved reply text containing `{{TagName}}` placeholders
  (e.g. `{{ContactName}}`, `{{TicketNumber}}`, `{{AppointmentTime}}`).
  Send is disabled while any `{{tag}}` remains in the compose box; known
  tags (contact/company name, ticket number) are pre-suggested on their
  own clickable chip, but still require a click to apply -- nothing is
  silently substituted straight into the message.

## API

- `GET /conversations?days=90&q=` -- list, filtered to the window and
  (optionally) a search term matched against company name, contact name,
  phone number, or any message's own ticket number.
- `GET /conversations/:id` -- full detail (conversation + every message +
  every note).
- `POST /conversations` -- `{ phoneNumber, companyId?, companyName?,
  contactId?, contactName? }` -- creates a conversation for a raw number,
  client link optional.
- `POST /conversations/:id/mark-read`, `PATCH /conversations/:id` (status/
  doNotContact/assignedTo), `POST`/`DELETE .../link-client`, `GET
  .../previous-ticket`, `POST .../notes`.
- `POST /conversations/:id/send` -- `{ body, ticketNumber? }`. Sends a
  real "quick SMS" through Access4 (`messageSubType: 'quick-sms'`,
  `campaignType: 'transactional'`) and logs the attempt into this
  conversation's own history either way -- a not-yet-working Access4
  account just logs as a failed send, it never blocks the rest of the
  page.
- `POST /conversations/:id/log-inbound` -- `{ body, ticketNumber? }` -- the
  manual stand-in described above.
- `GET /ticket-lookup?number=` -- validates a typed ticket number against
  real Autotask tickets (`listAll(client.tickets, [{op:'eq',
  field:'ticketNumber', value}])`, the same idiom used by Accrued Time/
  Workshop/Goods Received).
- `GET /company-search?q=`, `GET /companies/:id/contacts` -- the "Link to
  Client" picker's own two-step search (company, then that company's
  contacts).
- `GET/POST /templates`, `PUT`/`DELETE /templates/:id`.

## Setup

1. **IP whitelisting.** The Access4 API has no API key/token/Basic Auth at
   all -- it's gated purely by source IP. Ask your Access4 representative
   to whitelist wherever this dashboard server's outbound requests
   actually come from.
2. **Service and number ids** in `.env`:

   ```
   ACCESS4_SMS_SERVICE_ID=your_service_id
   ACCESS4_SMS_DID_NUMBER_ID=your_did_number_id
   ```

   `ACCESS4_SMS_BASE_URL` is optional, defaults to
   `https://api.sasboss.com.au:10000`. `ACCESS4_SMS_DID_NUMBER_ID` was a
   first guess at first build (the account's own sending number) -- if a
   real send fails, Access4's own error message (shown on the message
   bubble in the thread) is the first thing to check.

## Explicitly out of scope for now

- Writing SMS content into Autotask tickets.
- Clicking a client's phone number anywhere else on the dashboard to jump
  here.
- Automatic phone-number-to-Autotask-contact matching -- Autotask's
  `phone`/`mobilePhone` fields are only ever used for display elsewhere on
  this dashboard, never queried, and the stored formatting (spaces/dashes)
  makes a reliable digit-match genuinely uncertain. Client/contact linking
  is manual (search-and-pick) for now.
