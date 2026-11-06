// Synced from jpowersdev/effect-permission-examples by scripts/sync.mjs; edit it there.
/**
 * The smallest complete use of the permission modules: one rule, checked on
 * one document and then used as the WHERE clause of a list query. Run it with
 * `node examples/getting-started.ts` after `npm run build`.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Condition, Permission, PermissionSql, Principal } from "@jpowersdev/effect-permission"
import { SqlClient } from "effect/sql"

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

// One rule: admins read every document, and everyone else reads their own
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
  yield* sql`CREATE TABLE documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL)`
  yield* sql`INSERT INTO documents VALUES ('d-1', 'u-1', 'Shift schedule'), ('d-2', 'u-2', 'Budget')`

  // On one document: fails with PermissionDenied unless the rule holds
  const schedule = new Document({ id: "d-1", ownerId: "u-1", title: "Shift schedule" })
  yield* Permissions.require("documents:read", schedule)
  yield* Effect.log(`u-1 may read ${schedule.title}`)

  // On a list: the same rule, with u-1's values filled in, is the WHERE clause
  const permissionsSql = yield* PermissionsSql
  const visible = yield* permissionsSql.filter("documents:read")
  const rows = yield* sql<{ readonly title: string }>`SELECT title FROM documents WHERE ${visible}`
  yield* Effect.log(`u-1 sees ${rows.map((row) => row.title).join(", ")}`)
}).pipe(
  Effect.provideService(CurrentPrincipal, Principal.make({ subject: "u-1", attributes: { isAdmin: false } })),
  Effect.provide(Permissions.layer.pipe(Layer.provideMerge(PermissionsSql.layer))),
  Effect.provide(SqliteClient.layer({ filename: ":memory:" }))
)

NodeRuntime.runMain(program)
