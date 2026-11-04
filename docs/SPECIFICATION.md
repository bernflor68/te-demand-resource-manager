# T&E Demand & Resource Management — Functional Specification

> Original brief: Power Apps (Canvas) + SharePoint Lists. This repository delivers the same functional design as a standalone web app (Node.js + SQLite) so it can be hosted on a VPS. Section 8 keeps the SharePoint list design and maps each list to its table so the Power Platform variant remains buildable. Items not given in the brief are labeled **ASSUMPTION**.

## 1. Executive Summary
Tooling & Equipment (T&E) centralizes internal work requests and dispatches them to internal teams. Two modules: **Demand Management** (intake → triage → approval → dispatch → execution → closure) and **Resource Management** (people, weekly capacity in hours, unavailability, assignments) with two Gantt perspectives (by Resource, by Request). Target volume: ~2,000 requests/year, ~80 resources.

## 2. Business Objectives & Success Metrics
| Objective | Metric (target = ASSUMPTION) |
|---|---|
| One intake channel for all T&E work | ≥ 95 % of requests created in the app after 3 months |
| Faster triage | Median time Submitted → Pending Approval ≤ 2 working days |
| Visible, balanced workload | % resource-weeks above 100 % load ≤ 5 % |
| On-time delivery | % requests completed by requested due date ≥ 90 % |
| Traceability | 100 % of status changes and assignments in the audit trail |
| Data quality | 100 % of requests with the 7 mandatory fields |

## 3. Scope
**In (MVP)**: request intake with attachments; triage; single-level approval; dispatch Site → Team; resources with weekly capacity in hours; all-day unavailability; assignments (start/end/hours); Gantt by Resource and by Request (Day/Week/Month); in-app notifications and webhook; audit trail; dashboard, filtered lists, CSV export.
**Out (MVP)**: skill-based routing (V1/V2 option), partial-day unavailability, timesheets/actuals, cost tracking, item-level permissions, e-mail digests, mobile app, drag-and-drop rescheduling (V1).
**Stakeholders**: Requestors, Dispatch Managers/Team Leads, Technicians (resources), T&E management, IT/Platform owner.

## 4. Personas, Roles & Access Model
| Capability | Requestor | Technician | Dispatch Manager | Admin |
|---|---|---|---|---|
| Create request | ✔ | ✔ | ✔ | ✔ |
| View requests | Own | Own + own team + assigned | All | All |
| Edit request | Own, while Submitted/Triage | – | All open (incl. team, hours, safety) | All |
| Triage / approve / reject | – | – | ✔ | ✔ |
| Assign resources | – | – | ✔ | ✔ |
| Start / complete work | – | If assigned | ✔ | ✔ |
| Cancel | Own (Submitted/Triage) | – | ✔ | ✔ |
| Close | Own (Completed) | – | ✔ | ✔ |
| Resources, unavailability | – | View | Manage | Manage |
| Resource Gantt | – | ✔ | ✔ | ✔ |
| Users & reference data | – | – | – | ✔ |

Security model: Microsoft 365/Azure AD groups map 1:1 to these roles in the Power Platform variant; access is enforced **at application level with filtered queries** (no item-level permissions). In this web build, roles are stored per user and enforced server-side on every query (`visibility()`), ASSUMPTION: local accounts now, Entra ID/OIDC in V1.

## 5. User Journeys & Stories
1. **Requestor**: submits request → follows status/comments → confirms and closes. *As a requestor I want to submit a request with mandatory data and attachments so that T&E can act without follow-up questions.*
2. **Dispatch Manager**: opens Triage queue → sets team/priority/hours → submits for approval → approves → assigns resource(s) checking capacity → monitors Gantt.
3. **Technician**: sees own assignments in Gantt by Resource → starts work → completes.
4. **Planner**: records unavailability; sees over-capacity highlighted before confirming an assignment.
Stories: US-1 create request; US-2 filter my requests; US-3 triage; US-4 approve/reject with comment; US-5 assign with capacity check; US-6 see who is booked when; US-7 see request timeline with assignments; US-8 record leave; US-9 notified on assignment/status/due date; US-10 audit history; US-11 export CSV; US-12 administer users/lists.

## 6. Functional Requirements
### 6.1 Demand Intake & Management
- FR-1 Mandatory at creation: Title, Description, Site/Location, Equipment/Asset ID or name, Category, Priority (Low/Medium/High/Critical), Requested Due Date (not in the past), Requestor (auto). Attachments optional (≤10 MB, 20 per request, extension allow-list).
- FR-2 Auto number `TE-YYYY-NNNN`. FR-3 Optional Safety Impact (None/Low/High). FR-4 Comments and full audit trail per request.
- FR-5 List with search and filters: Site, Category, Priority, Status, Assigned Team, Assigned To, Requestor, due-date range, overdue, open-only; server-side sort and pagination (25/page). FR-6 CSV export honoring filters and visibility.
### 6.2 Triage / Dispatching
- FR-7 Dispatch Manager starts triage, sets Assigned Team (Site → Team routing; ASSUMPTION: manual choice in MVP, team suggestion by site in V1), estimated hours, priority.
- FR-8 Single-level approval: Pending Approval → Approved/Rejected (comment mandatory on reject). Optional V2: second approval when Safety Impact = High.
- FR-9 Assignments only on Approved/Scheduled/In Progress requests; first assignment auto-moves Approved → Scheduled; cancelling the last one reverts to Approved.
### 6.3 Resource Management
- FR-10 Resource: name, team, site, linked user, skills, weekly capacity (hours), active flag.
- FR-11 Capacity unit = HOURS. Daily capacity = weekly ÷ 5 on Mon–Fri (ASSUMPTION; no public-holiday calendar in MVP).
- FR-12 Unavailability: all-day start/end ranges with reason; daily capacity = 0; assignments overlapping it are rejected; adding unavailability over existing assignments warns.
- FR-13 Assignment: resource, start, end, planned hours (>0), notes. Hours are spread evenly across working days in the range.
- FR-14 Over-capacity detection per day; manager must confirm to override (recorded in audit trail).
### 6.4 Gantt Views
- FR-15 **By Resource**: one row per active resource; assignment bars (start→end, colored by priority, stacked in lanes when overlapping); hatched unavailability overlay; capacity strip per bucket showing booked/capacity and % (green <80 %, amber 80–100 %, red >100 %); filters Team, Site.
- FR-16 **By Request**: one row per request; one bar per assignment labeled resource · hours; due-date marker; filters Team, Site; max 300 rows.
- FR-17 Zoom: Week default, Day, Month; Prev/Next/Today; click a bar opens the request.
- FR-18 Technicians can restrict the resource Gantt to themselves; requestors only see the request Gantt limited to their own requests.

**Gantt technical options**
| # | Option | Prerequisites / governance | Verdict |
|---|---|---|---|
| 1 | PCF custom Gantt component | Power Apps component framework build pipeline, solution packaging, internal code review/ALM | **Recommended for V1** (Power Platform) |
| 2 | 3rd-party marketplace component | Licensing, vendor risk, data-flow review | **NOT recommended for MVP** |
| 3 | Lighter visualization (calendar + timeline/stacked galleries) | Standard controls only | **Recommended for MVP** (Power Platform) |
| – | This web build | Own HTML/CSS renderer (`public/gantt.js`), server-side aggregated data, no third-party library | Delivers the full Gantt in MVP |

How data is computed: **bars** = assignments overlapping the visible range, `left = (start − rangeStart) × pxPerDay`, `width = (end − start + 1) × pxPerDay`; **capacity vs booked** = per day `capacity = weekly/5` (0 on weekends/unavailable days), `booked = Σ planned_hours / workingDays(assignment)`, aggregated server-side into day/week/month buckets; **unavailability overlay** = ranges drawn as hatched rectangles over the row. One API call per view returns pre-aggregated rows, so the client needs no cross-list queries.

## 7. Non-Functional Requirements
- **Security**: server-side authorization on every endpoint; bcrypt passwords; HttpOnly SameSite cookies; Helmet CSP; login throttling; upload allow-list; CSV formula-injection guard; secrets only in `.env`.
- **Performance**: list/Gantt queries use indexed columns; Gantt range ≤ ~13 months; lists paginated server-side (works for 2,000 requests/year ≈ 10k rows in 5 years). Power Platform variant: delegable filters only, indexed columns, 5,000-item view threshold respected.
- **Auditability**: `audit_log` records every create/update/status change/assignment/attachment with user and timestamp; never edited.
- **Availability/Backup**: daily backup script, 14 retained; single-container restart in seconds.
- **Governance**: English-only UI; reference lists (sites, teams, categories) managed by Admin; no third-party UI components.

## 8. Data Model
Mapping: SharePoint list → table. Lookups are stored as IDs; Gantt data comes from `assignments` joined once server-side. **SharePoint notes**: index `Status`, `Site`, `AssignedTeam`, `RequestedDueDate`, `Requestor`, `StartDate`, `EndDate`, `Resource`; keep ≤ 12 lookup columns per list; attachments in the native attachment store (or a library if >20 files); denormalize `RequestNumber`, `Team`, `Site` into Assignments so Gantt views need no cross-list lookups.

### 8.1 Requests (`requests`)
| Name | Type | Required | Values/Format | Notes |
|---|---|---|---|---|
| number | Text | Auto | TE-YYYY-NNNN | Unique, indexed |
| title | Text(200) | ✔ | | |
| description | Multiline | ✔ | ≤5000 | |
| site_id | Lookup Sites | ✔ | | **Indexed** |
| equipment | Text(200) | ✔ | Asset ID or name | |
| category_id | Lookup Categories | ✔ | | Indexed |
| priority | Choice | ✔ | Low/Medium/High/Critical | Indexed |
| due_date | Date | ✔ | ISO date | **Indexed** |
| status | Choice | ✔ | see §9 | **Indexed** |
| requestor_id | Person | ✔ (auto) | | **Indexed** |
| team_id | Lookup Teams | at approval | | **Indexed** |
| safety_impact | Choice | – | None/Low/High | |
| estimated_hours | Number | – | ≥0 | |
| approver_id, decision_at, decision_comment | Person/Date/Text | – | | Set on approval/rejection |
| closed_at, created_at, updated_at, prev_status | Date/Text | system | | prev_status used by Resume |

### 8.2 Resources (`resources`)
| Name | Type | Required | Values/Format | Notes |
|---|---|---|---|---|
| name | Text | ✔ | | |
| user_id | Person | – | Azure AD/user | Links technician login |
| team_id | Lookup Teams | ✔ | | Indexed |
| site_id | Lookup Sites | – | | |
| weekly_capacity_hours | Number | ✔ | 0–80, default 40 | |
| skills | Text | – | free text (V1: multi-choice) | |
| active | Yes/No | ✔ | | |

### 8.3 Assignments (`assignments`)
| Name | Type | Required | Values/Format | Notes |
|---|---|---|---|---|
| request_id | Lookup Requests | ✔ | | **Indexed** |
| resource_id | Lookup Resources | ✔ | | **Indexed (composite with dates)** |
| start_date / end_date | Date | ✔ | end ≥ start | **Indexed** |
| planned_hours | Number | ✔ | >0 | |
| status | Choice | ✔ | Planned/Active/Done/Cancelled | Cancelled frees capacity |
| notes, created_by, created_at | Text/Person/Date | – | | |

### 8.4 Unavailability (`unavailability`)
resource_id (Lookup, indexed) · start_date/end_date (Date, indexed, end ≥ start) · reason (Text). All-day only.

### 8.5 Supporting lists (justification)
- **Sites / Teams / Categories** — admin-managed choice lists (renaming without schema change; inactive flag).
- **Users** (web build) — roles and credentials; in Power Platform replaced by M365 groups.
- **AuditLog** — append-only history (request_id, entity, action, user, JSON detail, timestamp); avoids SharePoint version-history limits and supports reporting.
- **Comments, Attachments** — per-request discussion and file metadata. **Notifications** — in-app inbox with de-duplication key.

Relationships: Requests 1—N Assignments N—1 Resources; Resources 1—N Unavailability; Requests/Assignments N—1 Sites/Teams/Categories; AuditLog/Comments/Attachments N—1 Requests.

## 9. Status Workflow & Business Rules
`Submitted → Triage → Pending Approval → Approved → Scheduled → In Progress → Completed → Closed`; side states **On Hold** (resume returns to previous status), **Rejected**, **Cancelled**.
| From | To | Who | Rule |
|---|---|---|---|
| Submitted | Triage | Manager | |
| Submitted/Triage | Cancelled | Manager, Owner | comment required |
| Triage | Pending Approval | Manager | team required |
| Triage / Pending Approval | Rejected | Manager | comment required |
| Pending Approval | Approved | Manager | sets approver/date |
| Pending Approval | Triage | Manager | comment required |
| Approved | Scheduled | system | first active assignment |
| Scheduled | In Progress | Manager, assigned Technician | assignments → Active |
| In Progress | Completed | Manager, assigned Technician | assignments → Done |
| Completed | Closed | Manager, Owner | |
| Completed | In Progress | Manager | reopen, comment required |
| Any open | On Hold → Resume | Manager | comment on hold |
| Approved/Scheduled/On Hold | Cancelled | Manager | assignments cancelled |
Rules: BR-1 no assignment before approval; BR-2 no assignment on unavailable days; BR-3 over-capacity needs explicit confirmation; BR-4 due date cannot be in the past at creation; BR-5 rejected/cancelled/closed requests leave Gantt capacity calculations.

## 10. Application Specification (Screens)
| Screen | Purpose | Key components | Visibility |
|---|---|---|---|
| Login | Authentication | email/password | All |
| Dashboard | KPIs | open/overdue/awaiting approval/due 7 d, breakdowns, 4-week utilization | All (utilization: non-requestors) |
| Requests | Search & filter | filter bar, sortable paged table, CSV | All (scoped) |
| New request | Intake | form with validation, attachments | All |
| Request detail | Work the request | status actions, info, assignments, attachments, comments, history, edit | Scoped; actions per role |
| Approvals | Queue of Pending Approval | preset filter of Requests | Manager/Admin |
| Gantt by Resource | Booking & capacity | zoom, filters, bars, overlays, strip | Non-requestors |
| Gantt by Request | Request timelines | zoom, filters, bars, due marker | All (scoped) |
| Resources | Maintain resources & unavailability | table, forms | Manager edit; Technician view |
| Admin | Users, sites, teams, categories | tables, forms | Admin |
Navigation: left menu (Dashboard, Requests, New request | Approvals, Gantt by Resource, Gantt by Request, Resources | Admin) + notification bell.
**Delegation / search strategy (Power Platform variant)**: filter on indexed, delegable columns (Status, Site, Team, DueDate ranges, Requestor); text search `startsWith` on Title only; Assigned To filtered through Assignments (indexed Resource); date-range Gantt queries filter `EndDate >= from && StartDate <= to`; paginate with ID-based paging; avoid `in`/`Search()` over large lists; use views with the 5,000 threshold in mind.

## 11. Automation & Notifications
| Trigger | Action | Recipients |
|---|---|---|
| Request created | In-app + webhook | Dispatch Managers |
| Status change | Notify | Requestor, assigned technicians (+ managers when Pending Approval) |
| Approval/rejection | Notify | Requestor |
| Assignment created/changed/cancelled | Notify | Resource user, Requestor |
| Due date ≤ 3 days / overdue | Hourly sweep, once per day per user | Requestor, managers, technicians |
Audit trail: every write path calls `audit()`; history shown on the request. Power Automate variant: one flow per trigger writing to AuditLog.

## 12. Reporting
Views: My requests, Pending approval, Overdue, By team, By site, Unassigned, Completed last 30 d. Power BI dataset suggestion: tables Requests, Assignments, Resources, Unavailability, AuditLog, Calendar; measures: lead time (Submitted→Closed), triage time, on-time %, utilization % = booked/capacity, backlog by status. Built-in: dashboard and CSV export.

## 13. Acceptance Criteria (Given/When/Then)
1. **Given** a signed-in requestor, **when** they submit the form with all mandatory fields, **then** a `TE-YYYY-NNNN` request in *Submitted* is created with them as requestor.
2. **Given** a missing mandatory field or a past due date, **when** submitting, **then** the request is rejected with an explicit message.
3. **Given** a requestor, **when** listing requests, **then** only their own are visible and others' ids return 404.
4. **Given** a *Submitted* request, **when** the manager starts triage and sets a team, **then** it can be submitted for approval; without a team the action is refused.
5. **Given** *Pending Approval*, **when** the manager rejects without a comment, **then** the action is refused; with a comment the status is *Rejected*.
6. **Given** *Pending Approval*, **when** the manager approves, **then** status is *Approved*, approver and date are stored and the requestor is notified.
7. **Given** a request not yet approved, **when** a manager tries to assign, **then** the assignment is refused.
8. **Given** an *Approved* request, **when** the first assignment is saved, **then** status becomes *Scheduled* automatically and the technician is notified.
9. **Given** a technician assigned to a *Scheduled* request, **when** they start and complete work, **then** the statuses change and unassigned technicians cannot.
10. **Given** *Completed*, **when** the requestor closes it, **then** status is *Closed* and closure time recorded.
11. **Given** filters Site + Priority + Status + Team + date range, **when** applied, **then** only matching requests are listed and CSV export matches.
12. **Given** any change, **when** opening the request, **then** the history shows who/when/what.
13. **(Resource)** **Given** a resource with 40 h/week already booked, **when** another assignment overlaps, **then** the app blocks it with a capacity message unless the manager confirms.
14. **(Resource)** **Given** an unavailability range, **when** assigning inside it, **then** the assignment is refused naming the range.
15. **(Gantt)** **Given** assignments exist, **when** opening Gantt by Resource in Week zoom, **then** each resource shows bars from start to end dates and a hatched overlay for unavailability.
16. **(Gantt)** **Given** a week with 50 h booked on 40 h capacity, **when** viewed, **then** the strip shows 125 % in red; booked and capacity hours appear in the tooltip.
17. **(Gantt)** **Given** Gantt by Request, **when** opened, **then** each request row shows its assignment bars with resource name/hours and a due-date marker; zoom Day/Week/Month re-renders the same data.
18. **(Gantt)** **Given** a requestor, **when** opening the resource Gantt, **then** access is denied; Gantt by Request shows only their requests.
**Definition of Done**: criteria pass (automated in `test/api.test.js` where possible), no console errors, role checks verified, documentation and deployment package updated, backup/restore tested.

## 14. Delivery Plan, Assumptions, Risks
- **MVP**: everything in §3 "In". **V1**: Entra ID SSO, e-mail notifications, drag-and-drop in Gantt, skills-based suggestion, holiday calendar, technician self-service unavailability, PCF Gantt (Power Platform variant). **V2**: second approval for Safety Impact = High, actual hours/timesheets, Power BI model, partial-day unavailability, item-level confidentiality exception.
- **Assumptions**: A1 Mon–Fri working week, 5 equal days; A2 single approval level; A3 manual team choice at triage; A4 local accounts in this build; A5 sample sites/teams/categories are placeholders; A6 evenly spread hours; A7 due-date reminder window = 3 days.
- **Risks / mitigations**: *Delegation* (Power Platform) → indexed columns, delegable filters, server-side pagination; *Permissions* → app-level filtering + groups; *Adoption* → simple form, notifications, training; *Data quality* → mandatory fields, reference lists; *Capacity realism* → manager override recorded in audit; *Single VPS* → backups, Docker restart policy.

## 15. Open Questions
1. Public-holiday and shift calendars per site? 2. Should requestors see assigned names/dates? 3. Is Azure AD SSO mandatory at go-live? 4. Retention period for closed requests and attachments? 5. Who may approve for which team (team-scoped approvers)? 6. Any confidentiality category requiring restricted visibility (V2 item-level exception)?
