# Projects v2: option updates, views, reserved names (spike)

- Date: 2026-11-27
- gh version: 2.81.0 (2025-10-01)
- Method: throwaway user-owned project (`sdlc-spike-tmp-<random>`), driven only through `gh api` /
  `gh api graphql`; the project was deleted afterwards (title verified before deletion).

## Option updates keep item values only when option ids are sent

`updateProjectV2Field(input: { fieldId, singleSelectOptions })` replaces the whole option list.
`ProjectV2SingleSelectFieldOptionInput` is `{ id?: String, name: String!, color: ColorEnum!, description: String! }`.

| Call | Item value afterwards |
|---|---|
| Existing options sent **with their ids** + one new option (no id) | **Preserved** (same option id, same name) |
| Existing options sent **without ids** + one new option | **Cleared** (`fieldValueByName` returns `null`; every option got a new id) |

- Values preserved: **yes, but only when the existing option ids are passed.**
- Verified on a custom single-select field and on the built-in `Status` field (Todo / In Progress / Done
  plus new options `Ready`, `Blocked`).
- `color` and `description` are required on every option; an empty description (`""`) is accepted.
  Existing colors/descriptions must be resent unchanged to keep them.
- Consequence: `OPTION_UPDATE_PRESERVES_VALUES = true`, and the implementation must resend every
  existing option with its `id`, `name`, `color` and `description`.

## View creation: works

Both routes work; the REST one carries filter, sort and grouping in a single call.

REST (preferred; org projects use `/orgs/{org}/projectsV2/{number}/views`, same body):

```
POST /users/{login}/projectsV2/{number}/views
{ "name": "...", "layout": "table" | "board" | "roadmap",
  "filter": "status:\"Awaiting deployment\"",
  "group_by": [<numeric field id>],            // table layout
  "vertical_group_by": [<numeric field id>],   // board columns
  "sort_by": [[<numeric field id>, "asc" | "desc"]],
  "visible_fields": [<numeric field id>, ...] }
```

Verified through GraphQL (`views.nodes.filter / sortByFields / groupByFields / verticalGroupByFields`)
that filter, `group_by`, `sort_by` and `vertical_group_by` are all applied. Field ids are the numeric REST
ids (`GET /users/{login}/projectsV2/{number}/fields`), not GraphQL node ids. The API does not reject a
duplicate view name, so existing views must be checked first.

GraphQL (partial): `createProjectV2View(input: { projectId, name, layout, configuration: { visibleFieldIds } })`
creates a view; `updateProjectV2View(input: { viewId, filter })` sets the filter afterwards. Neither can set
sort or grouping.

A new project starts with one table view named `View 1`.

## Reserved field name: `Type`

The REST field list of a fresh project contains a built-in `Type` field (`data_type: issue_type`,
GraphQL enum `ISSUE_TYPE`). GraphQL `ProjectV2.fields` and `ProjectV2.field(name: "Type")` do **not**
return it, but creating a custom field with that name fails:

```
createProjectV2Field(name: "Type", dataType: SINGLE_SELECT) ->
  UNPROCESSABLE: "Name cannot have a reserved value, Name has already been taken"
```

So a custom single-select named `Type` cannot be created through the API.

## Built-in fields on an empty project (GraphQL `fields`)

Title (TITLE), Assignees, Status (SINGLE_SELECT: Todo / In Progress / Done), Labels, Linked pull requests,
Milestone, Repository, Reviewers, Parent issue, Sub-issues progress, Created, Updated, Closed.
All except Status are non-custom and must be ignored by board provisioning.
