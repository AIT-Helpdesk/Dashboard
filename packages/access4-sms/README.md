# SMS (Access4)

Sends one-off SMS messages ("quick SMS") through Access4's SASBOSS SMS
Gateway API. Built as its own standalone page for now, by request --
contact lists, scheduled campaigns, SMS history, and delivery reports are
all real possible next steps (the underlying API supports them), just not
built yet.

Reference: https://infoboss.sasboss.com/en_AU/sms/sms-gateway-api-guide

## Setup

1. **IP whitelisting.** The API has no API key/token/Basic Auth at all --
   it's gated purely by source IP. Ask your Access4 representative to
   whitelist wherever this dashboard server's outbound requests actually
   come from. A call from a non-whitelisted IP fails outright.
2. **Service and number ids.** Find your SMS Gateway service's own
   `serviceId` and the sending number's `didNumberId` in the SASBOSS/
   Access4 portal (Numbers area of the SMS Gateway service -- this is a
   separate internal id, not the phone number's own digits). Set both in
   `.env`:

   ```
   ACCESS4_SMS_SERVICE_ID=your_service_id
   ACCESS4_SMS_DID_NUMBER_ID=your_did_number_id
   ```

   `ACCESS4_SMS_BASE_URL` is optional, defaults to
   `https://api.sasboss.com.au:10000`.

   Note: as of first build, the real `didNumberId` hadn't been located in
   the portal -- the account's own sending number (`61482090090`) was used
   as a first guess for this value. If sending fails with a message about
   an invalid/unrecognised number, that's the first thing to check --
   Access4's own error message in the response should say so directly (see
   `packages/access4-sms/data.db`'s `error` column, or the Recently Sent
   table on the page itself).

## API

- `GET /api/access4-sms` -- whether it's configured, plus the last 50
  messages sent from this dashboard (`packages/access4-sms/data.db`).
- `POST /api/access4-sms/send` -- `{ toMobile, message }`. Normalizes an AU
  mobile (`0412 345 678`, `+61412345678`, or `61412345678`) to the bare
  `61412345678` form the Access4 API's own examples use, sends it as a
  `messageSubType: "quick-sms"` / `campaignType: "transactional"` request
  (transactional bypasses the global opt-out list and is the type the
  guide itself specifies for quick-sms -- marketing campaign type can't be
  used for quick-sms at all), and logs the attempt either way (success or
  failure, with Access4's own error message if it failed).
