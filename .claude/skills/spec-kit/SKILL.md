---
name: spec-kit
description: GitHub Spec Kit templates (spec, plan, tasks, constitution, checklist) pinned at f6e72bc, adapted to this repo's conventions. Use when drafting a new feature spec or implementation plan from scratch; for REQ rows and task cards prefer club-requirements and club-task-slicer.
license: MIT (see LICENSE)
---

# Spec Kit templates

Vendored from https://github.com/github/spec-kit at commit `f6e72bc8523de8ec8368129cbdea78d45f27cef8` (MIT). Templates only: Spec Kit's slash commands and shell scripts are not vendored.

| Template | Use for | Our equivalent |
|---|---|---|
| `templates/spec-template.md` | A feature's user stories and functional requirements | Requirements become REQ rows (club-requirements) |
| `templates/plan-template.md` | Technical plan with Constitution Check and Complexity Tracking | Check against `docs/constitution.md`; record decisions as ADRs in `docs/adr/` |
| `templates/tasks-template.md` | `[ID] [P] [Story]` task lists | Cards in `specs/tasks/` (club-task-slicer) |
| `templates/constitution-template.md` | Reference only | Ours is `docs/constitution.md` (amend by PR, two founders) |
| `templates/checklist-template.md` | Requirement-quality checklists | Run before a REQ batch goes into the spec |

Copy a template's structure into the new document, fill every section or delete it with a one-line reason, and keep our ID formats (`REQ-<MOD>-NNN`, `TST-…`, `T-NNNN`). The live spec (Tab 3) stays the source of truth.
