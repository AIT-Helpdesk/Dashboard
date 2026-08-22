// The set of Strety metrics this automation keeps updated, and the exact
// Autotask query that defines each one's count. Add a new entry here to
// automate another metric -- nothing else needs to change.
//
// Each metric is matched against a real Strety metric by TEAM + TITLE
// (stripped of any "NOT READY:" prefix -- see What's On's README for that
// convention), not a hardcoded metric id -- consistent with how the rest of
// this dashboard resolves "Helpdesk Task Tracker" by name rather than id.
// sync.js treats finding zero or more-than-one match as a hard error rather
// than guessing, since this is a write.
//
// Confirmed against the real API (see @dashboard/autotask-client /
// packages/client-summary/server.js): "open" == status NOT IN [5 (Complete),
// 20 (Billing - Contract)]. This dashboard's usual convention also excludes
// issueType 14 (Monitoring Alert) dashboard-wide -- Set Priority/Overdue
// below follow that, but Urgent-Deadlines/TODAY-Jobs-Missed deliberately
// do NOT (by request -- these care purely about priority, and an alert
// escalated to a P1 priority is exactly as urgent as a human-raised one;
// this was a real correction, verified against real data the counts moved
// meaningfully once fixed). Check each entry's own comment, not this one,
// for whether Monitoring Alerts are in or out.
//
// The issueType/priority exclusions below are applied in JS AFTER
// fetching, not as API-level `notIn`/`noteq` filters -- confirmed against
// real data Autotask's API-level noteq/notIn silently drops NULL values
// from matching (standard SQL semantics, easy to miss), which would
// wrongly exclude real tickets that simply have no issueType set.
const CLOSED_STATUSES = [5, 20];
const MONITORING_ALERT_ISSUE_TYPE = 14;
const SET_PRIORITY_ID = 2; // "!! SET PRIORITY"
const TO_BE_SCHEDULED_ID = 12; // "!! TO BE SCHEDULED"
const P1_CRITICAL_ID = 4; // "P1 - CRITICAL"
const P1_DEADLINE_ID = 8; // "P1 - DEADLINE"
const P1_CANNOT_BE_MOVED_ID = 10; // "P1 - CANNOT BE MOVED"

// "Due date <= today", by request -- a CALENDAR-DATE comparison (due
// anytime today still counts, regardless of what time it is right now),
// not a moment-in-time one like Overdue's `dueDateTime < now` above. The
// confirmed-working `lt` operator is reused rather than an untested `lte`
// -- comparing against AEST midnight TOMORROW, expressed as its real UTC
// instant, gives an exactly equivalent result ("due before AEST midnight
// tomorrow" == "due today or any earlier day, AEST") without needing to
// verify a new operator or risk an off-by-one on the boundary. Same
// AEST-anchoring convention as every other date-scoped page on this
// dashboard.
function tomorrowAestMidnightUtcIso() {
  const nowAest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const tomorrowAestDateAtUtcMidnight = new Date(Date.UTC(nowAest.getUTCFullYear(), nowAest.getUTCMonth(), nowAest.getUTCDate() + 1));
  return new Date(tomorrowAestDateAtUtcMidnight.getTime() - 10 * 60 * 60 * 1000).toISOString();
}

const METRICS = [
  {
    team: 'Helpdesk Task Tracker',
    title: 'EOD - Tickets at Set Priority - Should be None',
    contextNote: 'Open tickets (status not Complete/Billing-Contract, excluding Monitoring Alerts) with priority "!! SET PRIORITY" -- counted automatically from Autotask.',
    async countTickets({ listAll, client }) {
      const tickets = await listAll(client.tickets, [
        { op: 'eq', field: 'priority', value: SET_PRIORITY_ID },
        { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
      ]);
      return tickets.filter((t) => t.issueType !== MONITORING_ALERT_ISSUE_TYPE).length;
    },
  },
  {
    team: 'Helpdesk Task Tracker',
    title: 'EOD - Tickets Overdue - Should be None',
    contextNote:
      'Open tickets (status not Complete/Billing-Contract, excluding Monitoring Alerts and priority "!! SET PRIORITY"/"!! TO BE SCHEDULED") whose due date has passed -- counted automatically from Autotask.',
    async countTickets({ listAll, client }) {
      const nowIso = new Date().toISOString();
      const tickets = await listAll(client.tickets, [
        { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
        { op: 'lt', field: 'dueDateTime', value: nowIso },
      ]);
      return tickets.filter(
        (t) => t.issueType !== MONITORING_ALERT_ISSUE_TYPE && ![SET_PRIORITY_ID, TO_BE_SCHEDULED_ID].includes(t.priority)
      ).length;
    },
  },
  {
    team: 'Helpdesk Task Tracker',
    title: 'EOD - Urgent/Deadlines not actioned',
    // Monitoring Alerts deliberately INCLUDED here, by request -- unlike
    // the other metrics on this list, this one cares purely about
    // priority: an automated alert that's been escalated to P1-CRITICAL/
    // P1-DEADLINE is exactly as urgent as a human-raised one.
    contextNote:
      'Open tickets with priority "P1 - CRITICAL" or "P1 - DEADLINE", due today or earlier -- counted automatically from Autotask. Includes Monitoring Alerts.',
    async countTickets({ listAll, client }) {
      const tickets = await listAll(client.tickets, [
        { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
        { op: 'lt', field: 'dueDateTime', value: tomorrowAestMidnightUtcIso() },
      ]);
      return tickets.filter((t) => [P1_CRITICAL_ID, P1_DEADLINE_ID].includes(t.priority)).length;
    },
  },
  {
    team: 'Helpdesk Task Tracker',
    title: 'EOD - TODAY Jobs Missed - Should be None',
    // Monitoring Alerts deliberately INCLUDED here too, same reasoning.
    contextNote:
      'Open tickets with priority "P1 - CANNOT BE MOVED", due today or earlier -- counted automatically from Autotask. Includes Monitoring Alerts.',
    async countTickets({ listAll, client }) {
      const tickets = await listAll(client.tickets, [
        { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
        { op: 'lt', field: 'dueDateTime', value: tomorrowAestMidnightUtcIso() },
      ]);
      return tickets.filter((t) => t.priority === P1_CANNOT_BE_MOVED_ID).length;
    },
  },
];

module.exports = { METRICS };
