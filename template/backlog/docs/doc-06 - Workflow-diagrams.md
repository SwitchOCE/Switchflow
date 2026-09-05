---
id: doc-06
title: Workflow diagrams
type: reference
tags: ["governance", "workflow", "mermaid"]
---

# Workflow diagrams

These diagrams show how work moves and what each role hands to the next. They are a map, not a rulebook.

Decision rules are owned by prose, not by these pictures. When a diagram and a governing document disagree, the document is correct. Conditions, thresholds, and exceptions live in the [Kanban workflow](/documentation/03/kanban-workflow), the [task contract](/documentation/07/task-contract), the [delivery contract](/documentation/08/delivery-contract), and [engineering standards](/documentation/04/engineering-standards).

Drawing decision logic here previously duplicated every rule in two places and made a policy change easy to apply to one copy only. These diagrams therefore show artifact flow and status, which a picture conveys better than prose, and leave conditional logic where it can be maintained.

## 1. Artifact pipeline

Each role reads the artifact the previous role produced instead of re-deriving it from source. Every artifact is smaller than the context that produced it.

```mermaid
flowchart LR
    G[Proposed goal] --> I([intake])
    I --> SC[Scope contract]
    SC --> P([plan-milestone])
    P --> PL[Phase plan]
    P --> TM[Task and context map]
    P --> UT[UAT task]
    PL --> O([orchestrate-phase])
    TM --> O
    O --> B[Task scope and approach]
    B --> D([deliver-task: phase agent or worker])
    D --> DF[Diff and handoff]
    DF --> RV([review-task])
    RV --> VD[Verdict]
    VD --> A([orchestrate-phase close])
    A --> PR[Phase record]
    A --> FR[Friction entry]
    UT --> UAT[Human acceptance test]
```

Rounded nodes are roles. Rectangles are artifacts. The chain is acyclic because rework loops belong inside a phase rather than in the pipeline.

Three levels bound the work. A **milestone** ends where {{OWNER_NAME}} can use the software and form an opinion, so it closes with a Human-assigned acceptance test. A **phase** ends at a gate the orchestrator verifies alone. A **task** is one delivery boundary with one useful result.

## 2. Phase loop

An orchestrator records durable state at each phase boundary. The next authorized phase can reuse focused context; restart when context is stale or crowded. Without host compaction, checkpoint and hand off before exhausting capacity, even mid-phase.

```mermaid
flowchart TD
    S[Phase opens] --> R1[Read milestone record<br/>and prior phase record]
    R1 --> DP[Select ready phase task or group]
    DP --> CK{Delivery approach matches<br/>task scope and context map?}
    CK -- No --> CR[Correct before implementation]
    CR --> DP
    CK -- Yes --> IM[Phase agent or worker delivers<br/>diff and handoff]
    IM --> RV[Independent review<br/>of the fixed diff]
    RV --> AC{Verdict}
    AC -- Blocking finding --> DP
    AC -- Accepted --> IN[Integrate in dependency order]
    IN --> GT{Phase gate condition met?}
    GT -- No, work remains --> DP
    GT -- No, owner decision needed --> XQ[Record open question and pending work;<br/>return control]
    GT -- Yes --> CL[Run cleanup script;<br/>resolve exceptions only]
    CL --> WR[Write phase record<br/>and friction entries]
    WR --> AUTH{Next phase authorized?}
    AUTH -- No --> X[Return control with phase record]
    AUTH -- Yes --> CT{Context focused and useful?}
    CT -- Yes --> S
    CT -- No --> HC[Compact or hand off to fresh context]
    HC --> S
```

When the orchestrator needs a decision from {{OWNER_NAME}}, it records the question and pending work and returns control. Resume after the decision in the same or a fresh context as appropriate. Retaining context never grants authority for another phase.

Every task starts with the three-line approach. The phase agent confirms delegated approaches and checks its own against the accepted task. Both delivery modes produce the same evidence and independent review boundary.

## 3. Status lifecycle

```mermaid
flowchart LR
    B[Backlog] -->|Full readiness gate passes| R[Ready]
    R -->|Explicit execution authority| P[In Progress]
    P -->|Implementation, evidence and handoff complete| V[Review]
    V -->|Independent acceptance and required integration pass| D[Done]
    V -->|Blocking finding recorded| R
    B -->|Prepared; named prerequisite missing| X[Blocked]
    R -->|Executable prerequisite lost| X
    P -->|Named obstruction prevents progress| X
    V -->|Named obstruction prevents review or integration| X
    X -->|Resolved and full readiness gate passes| R
    X -->|Scope needs definition| B
    X -->|Review evidence still valid| V
    B -. Material decision missing .-> N[needs-decision label]
    N -. Decision recorded and all exceptions resolved .-> B
    B -. Reviewer priority choice .-> H[high-priority label]
    H -. Label changes ordering, not status .-> B
```

**Backlog** needs definition; **Blocked** is prepared work waiting on a named prerequisite, before or after execution. `needs-decision` identifies a user-owned choice in either state. `high-priority` changes ordering, not status. Coordination parents follow the separate rollup lifecycle in the Kanban workflow.

Readiness does not authorize implementation. The [Kanban workflow](/documentation/03/kanban-workflow) owns which actor may make each transition.

## Where the rules live

| Question | Answer |
| --- | --- |
| When is a task Ready? | [Task contract](/documentation/07/task-contract), readiness gate |
| Who may change status or accept work? | [Kanban workflow](/documentation/03/kanban-workflow), ownership and authority |
| How is work coordinated, reviewed and integrated? | [Delivery contract](/documentation/08/delivery-contract) |
| How much verification does this change need? | [Engineering standards](/documentation/04/engineering-standards), risk and verification |
| Does this change durable documentation? | [Maintaining documentation](/documentation/05/maintaining-documentation) |
| What is in and out of scope for this milestone? | The milestone's scope contract |
