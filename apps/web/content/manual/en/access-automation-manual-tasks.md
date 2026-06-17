---
title: Manual tasks
order: 3
category: access-automation
subcategory: manual-tasks
---

# Manual tasks

Not every provisioning step can be automated. A **manual task** is a step that **pauses the run** and
asks a person to act, then resumes once they are done. lazyit creates a manual task in two cases:

- A **Human task** step in the workflow (a deliberate "a person must do this" step — for example,
  "decide which team to add this user to").
- An **Escalated failure** — an API or webhook step failed and its **On failure** edge was set to
  *Escalate to a human*.

While a run is paused it sits in the **Waiting (manual)** state and costs nothing; it stays paused
until a person completes the task — there is no timeout pressure to act immediately.

## The manual-task inbox

Pending manual tasks across all applications collect in one **inbox**, reached from **Settings →
Integrations**. The inbox lists each task with its **Step**, its origin (Manual step or Escalated
failure), and its **Age**. The notification bell nudges the right people when a task appears, so you
do not have to watch the inbox.

## Completing a task

Open a task to see **what happened** (the step and why the run paused) and **your input** — the typed
fields the workflow author defined for you to fill in (text, number, yes/no, or a choice from a
dropdown). You have three actions:

- **Submit** — provide the requested input. The run **resumes** from where it paused and continues
  through the remaining steps.
- **Skip step** — skip this step and continue the run without it.
- **Fail run** — stop the run as failed. You can record a short **reason**. The grant is never
  touched — failing the run only stops the automation.

After you act, the task is marked **Completed** (or **Cancelled**) and shows as resolved; it cannot
be acted on twice.

## Who can act

Completing a task needs the **`workflow:task`** permission **and** that you are an allowed assignee —
permission alone is not enough if the task is scoped to a particular person or cohort. If you do not
have permission for a task, the form tells you so and is disabled. See
[Permissions](/help/access-automation-permissions).

> The values you type are treated as plain input — they fill the fields the workflow author mapped,
> and are never run as code or expressions.
