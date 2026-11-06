# @jpowersdev/effect-permission

Authorization rules for [Effect](https://effect.website), written once and enforced on a loaded record, in SQL list queries, on writes and at HttpApi and Rpc endpoints.

This is an unofficial, experimental package. The same modules are being proposed for Effect itself as `effect/permission`, and this package is generated from that work so it can be used in the meantime. Expect breaking changes between 0.x versions. If the modules land in Effect, moving over is mostly a change of import path.

## Install

```sh
npm install @jpowersdev/effect-permission
```

It needs `effect` 4.1.2 or later.

## Example

One rule, checked on one document and then used as the `WHERE` clause of a list query:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { Condition, Permission, PermissionSql, Principal } from "@jpowersdev/effect-permission"

// The caller, as the rules see it. The attributes are the application's own.
class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal.Principal<{ readonly isAdmin: boolean }>
>()("app/CurrentPrincipal") {}

class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  ownerId: Schema.String,
  title: Schema.String
}) {}

// Admins read every document, and everyone else reads their own
const DocumentRules = Permission.rules(CurrentPrincipal, Document)
  .action("documents:read", {
    filter: ({ principal, resource: document }) =>
      Condition.or(principal.attributes.isAdmin, Condition.eq(document.ownerId, principal.subject.id))
  })

const Permissions = Permission.make(CurrentPrincipal, { rules: [DocumentRules] })

// Where documents live, so the rule can become SQL
class PermissionsSql extends PermissionSql.Service<PermissionsSql>()("app/PermissionsSql", {
  permissions: Permissions,
  tables: [PermissionSql.table(Document, "documents", { ownerId: "owner_id" })]
}) {}

const program = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  // On one document: fails with PermissionDenied unless the rule holds
  yield* Permissions.require("documents:read", new Document({ id: "d-1", ownerId: "u-1", title: "Shift schedule" }))

  // On a list: the same rule, with the caller's values filled in, is the WHERE clause
  const visible = yield* (yield* PermissionsSql).filter("documents:read")
  return yield* sql`SELECT title FROM documents WHERE ${visible}`
}).pipe(
  Effect.provideService(CurrentPrincipal, Principal.make({ subject: "u-1", attributes: { isAdmin: false } })),
  Effect.provide(Permissions.layer.pipe(Layer.provideMerge(PermissionsSql.layer))),
  Effect.provide(SqliteClient.layer({ filename: "app.db" }))
)
```

The [walkthrough](https://github.com/jpowersdev/effect-permission-examples/blob/main/WALKTHROUGH.md) goes through each module with code from an example app and the output it produces. It imports from `effect/permission`, the proposed upstream path; the API is the same under this package's name.

## Modules

- `Principal`: the caller, signed-in, a guest or the system, with the application's own attributes.
- `Condition`: the expressions rules are written in.
- `Permission`: rules per resource type, and the application's typed `Permissions` object.
- `Authorizer`: the service that makes decisions.
- `PermissionError`: `Unauthenticated` (401), `PermissionDenied` (403) and `PermissionUnavailable` (503).
- `PermissionMiddleware`: authorization middleware for HttpApi and Rpc.
- `PermissionSql`: compiles rules into SQL, and answers relation lookups from tables.

Each can also be imported on its own, such as `@jpowersdev/effect-permission/Condition`.

## Notes

- On `effect` 4.1.2, an RPC whose handler calls `Permissions.require` must also declare `PermissionError.PermissionError` in its `error`. From 4.1.3, handlers may fail with their middleware's errors ([Effect-TS/effect#10418](https://github.com/Effect-TS/effect/pull/10418)).

## Development

The modules, tests and type tests are generated from the [`permission` branch](https://github.com/jpowersdev/effect/tree/permission) of a fork of Effect. Make changes there, then sync:

```sh
npm run sync          # copy from a local checkout of the fork (--repo, --ref)
npm run sync:check    # fail if the files differ from the fork
npm run validate      # type-check, test, type-test, build, and test the packed package
```

`SOURCE` records the fork commit the files came from.

## License

MIT
