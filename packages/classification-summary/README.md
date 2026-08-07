# @dashboard/classification-summary

Dashboard page: a horizontal bar chart, one bar per `Companies.classification` value, counting active clients. Click a bar to open that classification's client list below the chart (company name, state, phone) -- no extra request, since the full company list per group is already in the initial payload. No filters or date scoping -- a live snapshot, auto-loaded on open (with a Refresh button), unlike every other page on this dashboard, which waits for an explicit Search click. That's a deliberate difference, not an oversight: every other page has criteria to fill in first; this one doesn't, so there's nothing to wait for.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/classification-summary`.

## Scope

Active companies only, restricted to `companyType` Customer (1) or Prospect (3) -- the same "clients" definition Client Details and Client Contacts use.

## Classification bucketing

`Companies.classification` is a picklist field storing an integer code; the label is resolved via `getPicklistLabels()` in `@dashboard/autotask-client` (shared with Client Details / Client Contacts, cached). A company with no classification set at all falls into an "Unclassified" bucket rather than being dropped -- every active client is accounted for in one bar or another. Bars are sorted by count descending, so the largest groups lead.

## Bar color

Classification names are NOMINAL, not ordinal -- swapping their display order doesn't change what they mean (unlike, say, funnel stages or size tiers, where order carries meaning and would call for a one-hue lightness ramp). Per the dataviz skill's color-job rules, nominal categories that aren't being compared as identity-bearing series all take the *same* single accent hue; bar length already encodes the count, so shading each bar by its own magnitude would spend the color channel re-encoding what the length already shows. A distinct hue per classification would also have been the "generated 9th+ hue" anti-pattern for the ~15 classification values this Autotask instance has configured.

## Click-to-drill-down

Each bar is a real `<button>` (not a `<div>` with a click handler), so it's keyboard-operable (Tab + Enter/Space) with a visible focus ring for free, no extra ARIA wiring beyond `aria-expanded` to track which bar is currently open. Clicking the open bar again closes the drill-down; clicking a different bar swaps to that classification's list. The drill-down table reuses the same `.resource-group` card styling as every other page's result tables.
