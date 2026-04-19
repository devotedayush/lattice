I summoned three agents: founder, PM, and GTM/design partner. Their consensus is pretty strong: **Lattice should not become another task manager.** Its sharpest identity is a **live team reality layer**: it listens to messy updates, tracks goals, commitments, blockers, assumptions, confidence, drift, and tells leaders what changed and what needs action.

**Core User Pain**
Founders and PMs are both fighting the same beast: the plan is in one place, reality is scattered everywhere.

The problems they named:

1. **Nobody knows what is actually true right now**
   Slack says one thing, Linear/Jira says another, standup adds nuance, founders remember half of it, and risk hides between systems.

2. **Goal drift is invisible until it hurts**
   The team thinks the goal is “ship Friday demo,” but people may still be working on old scope. Lattice already maps this with `goalDrift` and the Plan vs Reality view.

3. **Risks are usually social and contextual**
   “Legal is quiet,” “Priya is overloaded,” “the API assumption broke,” “customer launch slipped” are not normal task states, but they are exactly the kinds of things Lattice can model.

4. **PMs waste time extracting signal**
   They constantly ask: what changed, who is blocked, what is stale, which assumptions broke, what needs escalation?

5. **Founders need a chief-of-staff brain before they can hire one**
   The strongest founder use case is: open Lattice in the morning and know what matters, what changed, what is at risk, and what decision needs to happen today.

**Where Lattice Already Aligns**
The app is already pointed in the right direction.

The strongest existing surfaces are:

- Pulse view: active goal, confidence, blockers, at-risk count, recent changes, suggested next actions in [app/page.tsx](/Volumes/SSD/code/hack1/orgmind/app/page.tsx):890
- Natural-language/voice update composer in [app/page.tsx](/Volumes/SSD/code/hack1/orgmind/app/page.tsx):1665
- AI interpretation that extracts goals, blockers, assumptions, changes, confidence impact, and interventions in [lib/ai-v2.ts](/Volumes/SSD/code/hack1/orgmind/lib/ai-v2.ts):1
- State graph types for goals, assumptions, dependencies, confidence signals, interventions, and change events in [lib/v2.ts](/Volumes/SSD/code/hack1/orgmind/lib/v2.ts):104
- Ask Lattice endpoint for questions like “who’s overloaded?” and “is the goal realistic?” in [app/api/v2/ask/route.ts](/Volumes/SSD/code/hack1/orgmind/app/api/v2/ask/route.ts):14
- Analysis endpoint that suggests interventions for drift, overload, blockers, stale commitments, and assumptions in [app/api/v2/analyze/route.ts](/Volumes/SSD/code/hack1/orgmind/app/api/v2/analyze/route.ts):47

The product’s real magic is: **turn messy human updates into structured operational memory.**

**Where It Misses**
The big adoption blockers are clear:

1. **Too manual right now**
   Users will not reliably maintain another app. Lattice needs Slack, Linear/Jira, GitHub, calendar, docs, and meeting-note ingestion.

2. **Interventions are not yet action loops**
   Today an intervention can be dismissed or marked acted. Founders and PMs need: assign, notify, draft message, schedule check-in, set owner, escalate, verify outcome.

3. **Trust layer is thin**
   Users need provenance and correction: source text, author, timestamp, undo, merge duplicates, edit type, correct owner, explain confidence change.

4. **Commitments are too flat**
   They need due dates, real owners, linked goal/milestone/customer, last update, aging, source, escalation history.

5. **Assumptions are underused**
   Assumptions are one of the most differentiated ideas here, but they need owner, evidence, validation date, review workflow, and visible impact.

6. **PM/founder stakes are missing**
   Current Lattice tracks execution confidence, but founders and PMs think in launch dates, customer promises, revenue risk, investor demos, runway, churn, and product milestones.

7. **One implementation issue**
   The stale commitment analysis appears to parse `f.pulse` as a date in [app/api/v2/analyze/route.ts](/Volumes/SSD/code/hack1/orgmind/app/api/v2/analyze/route.ts):137, but `pulse` is a state like `active`, `tense`, or `quiet`. For reliable stale detection, `FieldObject` needs real `createdAt` / `updatedAt`.

**Best Positioning**
Do not pitch this as “AI project management.”

Better:

> Lattice turns messy team updates into a live model of goals, blockers, assumptions, and execution risk.

Even sharper:

> Know what changed before the plan breaks.

Good wedge:

> Async standup, execution memory, and risk detection for fast-moving teams.

The strongest target users:

1. Startup founders with 3-15 person teams
2. Product and engineering pods shipping under deadline
3. Chief-of-staff / ops leads coordinating across functions
4. Async teams that need “what changed while I was away?”

**Roadmap Bets**
I’d prioritize these:

1. **Founder / PM Morning Brief**
   A daily “what changed, what matters, what needs a decision” digest at the top of Pulse. This can use the existing state graph and a new `/api/v2/brief`.

2. **Slack-first Async Standup**
   Let teammates update from Slack, then Lattice extracts commitments, blockers, assumptions, and confidence shifts. This creates habit without forcing people into the app.

3. **Trust And Correction Layer**
   Every extracted item should show source, author, timestamp, and allow edit, merge, undo, reclassify, and “not true.”

4. **Intervention Workflows**
   Upgrade “What to do next” into executable actions: assign owner, draft Slack message, create follow-up, set deadline, link blocker, ask for reconfirmation.

5. **Launch / Milestone Layer**
   Add launches or milestones tied to goals, commitments, blockers, assumptions, and confidence. PMs want to know: “Can we ship the thing?”

6. **Assumption Review Workflow**
   Make assumptions first-class: owner, evidence, due date, validation status, tied goal, affected commitments, reconfirm/ invalidate actions.

7. **Stakeholder Update Generator**
   Generate updates for execs, investors, GTM, customers, or the team: what changed, risks, asks, decisions needed, confidence.

8. **Linear/GitHub Integration**
   Pull issues, PRs, labels, and statuses. Then Lattice can answer: “Which promises are not backed by tickets?” or “Which blockers have no PR/owner?”

9. **Decision Log**
   Preserve decisions separately from change events: what was decided, why, who decided, tradeoffs, revisit date.

10. **Customer / Revenue / Runway Impact**
   Let goals and blockers connect to customers, ARR, investor deadlines, launches, or runway. That makes Lattice founder-native instead of generic team-native.

**My Take**
Lattice has a genuinely strong thesis. The app should become **the operating memory for fast-moving teams**, not a prettier project board.

The highest-leverage next move is probably:

1. Add a **Morning Brief** surface.
2. Add **real stale/aging metadata** for commitments.
3. Turn **interventions into assignable workflows**.
4. Start a **Slack ingestion wedge**.

That path keeps the current soul of the app intact: messy updates go in, organizational clarity comes out.