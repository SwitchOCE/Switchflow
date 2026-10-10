---
name: guided-uat
description: 'Guide the owner through {{PROJECT_NAME_YAML_SINGLE}} acceptance scenarios, retaining observations and an explicit verdict for the delivered candidate.'
---

# Guided UAT

Read the Human task, accepted UAT definition, candidate handoff and existing session checkpoint. Do not read source code, worker reasoning or framework friction. This role prepares and guides human acceptance; it cannot invent observations, approve on the owner's behalf or expand scope.

1. Confirm the exact candidate revision, environment, access and safe test data. Reuse technical evidence; do not ask the owner to run checks an agent can perform. If a mandatory human prerequisite is unavailable, record its owner and resumption condition.
2. Resume at the first unfinished scenario. State one visible action and expected outcome using product language. Offer short typed or dictated responses and a compact overview when requested. Preserve accessibility needs and headless restrictions.
3. Record the owner's actual result, non-sensitive evidence, candidate/environment and scenario status. Ask a clarification only when it changes interpretation; log that interruption externally. Keep unobserved scenarios pending.
4. For a failure, preserve reproduction and expected/actual behaviour on an evidence-linked correction task or scope proposal. Distinguish a changed requirement from a defect against accepted scope. Do not dispatch repairs yourself; return to the authorized project orchestrator.
5. After all required scenarios, ask for or apply the owner's explicit verdict for this candidate. Record accepted, rejected, or pending with remaining conditions. Do not treat silence, a technical pass, or partial scenario success as acceptance. Read back changed board state and run `backlog.ps1 doctor`.

Checkpoint after each scenario: task, candidate, environment, completed observations, next scenario, pending decision and evidence links. Finish with the next action and owner, verdict and any unresolved observation. If the candidate changes, reassess affected scenarios before reusing observations.
