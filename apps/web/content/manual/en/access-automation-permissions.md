---
title: Permissions
order: 5
category: access-automation
subcategory: permissions
---

# Access Automation permissions

Access Automation has its own set of permissions so you can separate **who builds workflows**, **who
runs them**, **who completes manual tasks**, and **who holds the credentials**. There are five:

| Permission | What it allows |
| --- | --- |
| **`workflow:read`** | View workflows, connections, run history and the manual-task inbox. |
| **`workflow:manage`** | Configure the engine — create, edit, delete and enable/disable workflows and connections. |
| **`workflow:run`** | Manually retry or replay a run. |
| **`workflow:task`** | Complete a manual task (plus you must be an allowed assignee). |
| **`workflow:secrets`** | Add, replace or remove the credentials a connection uses. |

## Safe default: administrator-only

On a fresh install **all five are held by Administrator only**. Members and Viewers get none of them
by default — automation, like the activity log and the Secret Manager, starts locked to
administrators. An administrator can delegate any of them to Member or Viewer from the
role-permission settings (see [Permissions](/help/permissions) for how role tuning works).

## Separation of duties

The split is deliberate, so responsibilities can be held by different people:

- **`workflow:manage` vs `workflow:secrets`.** Building a workflow and holding its credentials are
  **separate** permissions. You can let someone design and edit workflows without ever handing them
  the ability to enter or rotate the API tokens those workflows use — and vice-versa. Credentials are
  write-only regardless of who holds this permission: the value goes in once and is never shown again.
- **`workflow:task` is not enough on its own.** Completing a manual task requires both the permission
  **and** that you are an allowed assignee for that task. Having `workflow:task` does not let you act
  on tasks meant for someone else.

## Tuning the defaults

Granting any of these to Member or Viewer is a meaningful delegation, so lazyit marks it clearly and
asks you to confirm — it does not stop you. Administrator always holds every permission and cannot be
edited.
