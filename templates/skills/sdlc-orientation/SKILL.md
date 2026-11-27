---
name: sdlc-orientation
description: "Use at the start of work in this repository to learn what the project is, how it is laid out, which commands to run and what to watch out for. The owner fills in the marked placeholders."
---

# Project orientation

> **Owner:** replace every `[FILL IN: ...]` below with a few plain sentences, then delete this note. Once you edit this file, the installer keeps your version when the kit is upgraded.
>
> **Agents:** read this before changing anything. Where a `[FILL IN: ...]` is still there, say so and ask the owner; do not guess.

## Purpose

[FILL IN: what this project is, who uses it and what "working" means for them, in two to four sentences.]

## Architecture map

[FILL IN: the main parts and how data flows between them, in a few lines. Name the external systems it depends on.]

| Path | What lives there |
|---|---|
| [FILL IN: path] | [FILL IN: what it owns] |
| [FILL IN: path] | [FILL IN: what it owns] |

## Commands

From the sdlc config:

- Default branch: `{{defaultBranch}}`
{{#if qualityGate}}
- Quality gate, run before every review handoff:
{{#each qualityGate}}
  - `{{.}}`
{{/each}}
{{else}}
- Quality gate: none configured.
{{/if}}
{{#each targets}}
- Deployment target `{{name}}`: environment `{{environment}}`, {{deployText}}.
{{/each}}

Not in the config:

- Install and set up: [FILL IN: command]
- Run locally: [FILL IN: command]
- Run one test: [FILL IN: command]
- Lint and format: [FILL IN: command]
- Build: [FILL IN: command]

## Conventions

[FILL IN: naming, code style, error handling, what a good test looks like, where documentation goes.]

## Gotchas

[FILL IN: what breaks easily, flaky or slow tests, generated files not to edit, ordering traps, anything that surprised a newcomer.]

## Where decisions are written down

[FILL IN: where specs, plans, ADRs and runbooks live.]
