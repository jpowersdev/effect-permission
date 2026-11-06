<!-- Synced from jpowersdev/effect-permission-examples by scripts/sync.mjs; edit it there. -->

# Overview

The `@jpowersdev/effect-permission` modules let you write authorization rules once, as
data, and enforce them everywhere a request touches your data:

- **At the endpoint**, before the handler runs.
- **On a record** the handler has loaded.
- **In list queries**, as the SQL `WHERE` clause.
- **On writes**, on the value about to be written.

A rule is a condition over two things: the principal (who is calling) and the
resource (what they're acting on). Because it's a condition rather than a
function, the same rule can be checked against one record in memory or
compiled into SQL. The rule shape, `filter`, `check` and `set`, comes from
Hasura's permissions. `forbid` overrides everything else, as in Cedar.

There are seven modules:

- **Principal**: the caller, which is a signed-in user or service, a guest, or the system.
- **Condition**: the expressions rules are written in.
- **Permission**: declares rules per resource type, and builds the app's typed `Permissions` object.
- **Authorizer**: the service that makes every decision.
- **PermissionError**: the errors checks fail with, which respond with 401, 403 and 503.
- **PermissionMiddleware**: enforces rules at HttpApi endpoints and RPCs.
- **PermissionSql**: compiles rules into SQL, and looks relation facts up in SQL tables.

```
Principal ─┐
           ├─► Permission.rules ─► Permission.make ─► Permissions
Condition ─┘                                          ├── can, require   ─► one record
                                                      ├── create, update ─► writes
                                                      ├── filter         ─► PermissionSql ─► list queries
                                                      └── Required       ─► PermissionMiddleware ─► endpoints and RPCs
```

The `Authorizer` makes every decision behind those methods, and
`PermissionError` is how it says no.

Unless an example says otherwise, its code comes from
[effect-permission-examples](https://github.com/jpowersdev/effect-permission-examples), a shift-swap API described in its
[README](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/README.md). Nurses swap shifts on
hospital units, and a unit's manager approves the swap. The seeded profiles
are:

- Ana, a nurse;
- Ben, a float nurse;
- Cara, who manages the ICU;
- Dev, a super admin;
- Eve, on the support team.

# Getting Started

This is the smallest complete program: one rule, checked on one document and
then used as the `WHERE` clause of a list query. It's
[`examples/getting-started.ts`](examples/getting-started.ts) in this repo, and you
can run it with `node examples/getting-started.ts` after `npm run build`.

**Example** (One rule, two uses)

```ts
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
```

Output:

```
INFO: u-1 may read Shift schedule
INFO: u-1 sees Shift schedule
```

The program has four parts:

1. **The principal.** The application declares it as an ordinary service, and
   chooses the attribute type itself.
2. **The rules.** `Permission.rules` declares them for one resource type.
   - The rule function runs once, when the action is declared.
   - `principal` and `resource` are references to fields, not values. So
     `Condition.eq(document.ownerId, principal.subject.id)` records a
     comparison instead of making one.
3. **`Permissions`.** `Permission.make` builds the object handlers use.
   `Permissions.layer` is the in-process `Authorizer`, which evaluates the
   rules.
4. **SQL.** `PermissionSql.Service` says where documents are stored.
   - Its `filter` takes the rule and fills in the caller's values.
   - For `u-1`, `isAdmin` is false, so that half of the `or` drops out, and
     the query only matches rows owned by `u-1`.

# Principals

The principal is who a check is about. It's one of three things:

- **Authenticated:** a signed-in user or service, with the application's own
  attributes.
- **Guest:** a caller with no credentials. A guest is denied every action, and
  gets a 401.
- **System:** the application acting on its own authority, for background
  jobs. The system is allowed every action.

## Declaring the principal

The application owns the attribute type and provides the principal as its own
service. Handlers that check permissions then require that service, so the
compiler makes sure some middleware provides it.

**Example** (The app's principal, from [`src/permissions/Principal.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Principal.ts))

```ts
import { Context, Schema } from "effect"
import type { Principal } from "@jpowersdev/effect-permission"
import { HospitalId, type ProfileId } from "../domain/Ids.ts"

export class Member extends Schema.Class<Member>("Member")({
  homeHospitalId: HospitalId,
  isSuperAdmin: Schema.Boolean,
  managesUnits: Schema.Boolean,
  managesSwaps: Schema.Boolean
}) {}

export class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal.Principal<Member, ProfileId>
>()("examples/CurrentPrincipal") {}
```

The second type parameter is the type of the subject's id. Because it's a
branded `ProfileId`, rules can compare the subject id with `ProfileId` fields,
and `set` can write it into them.

## Building a principal for each request

Authentication builds the principal. In the example app it verifies a JWT, reads the
profile row, and puts the principal together with `Principal.make`.

**Example** (From [`src/server/Authenticator.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Authenticator.ts))

```ts
return Principal.make({
  subject: claims.sub, // a ProfileId
  attributes: new Member(profile), // what the rules read
  actor: claims.act?.sub, // set when support acts as this profile
  limit: claims.scope?.split(" "), // the only actions this token may use
  revision: claims.rev // changes when the profile's access changes
})
```

The authentication middleware provides `Principal.guest` when there's no
token.

**Example** (From [`src/server/Http.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Http.ts))

```ts
const principal = Redacted.value(credential) === ""
  ? Principal.guest
  : yield* authenticator.authenticate(credential)
return yield* Effect.provideService(httpEffect, CurrentPrincipal, principal)
```

For work the application does itself, provide
`Principal.system("nightly-import")`. The name identifies the job.

## Limits

A limit narrows what one request may do, whatever the rules allow. Use limits
for credentials that are narrower than the person, such as a link sent by
text message or an API key. A principal can have several limits, and each one
must include the action.

In the example app, a token's `scope` becomes a limit. A text-message link carries
`swaps:respond`, which is an alias for two actions (see
[Combining rule sets](#combining-rule-sets)). With that token, Ana can read and
accept swaps, and nothing else:

```ts
yield* Permissions.can("units:read", icu) // with Ana's text-message token
// { _tag: "Deny", action: "units:read", reason: "Limit" }
```

`Principal.withLimit(principal, actions)` adds a limit to a principal you
already have.

## Acting on someone's behalf

`actor` records that someone else is acting as the subject, for example a
support user impersonating a manager. Rules can refer to `principal.actor`.
The example app uses it to stop impersonators approving swaps (see
[Forbidding](#forbidding)). `Principal.withActor` sets it on a principal you
already have.

## Lazy attributes

All of the example app's attributes come from the profile row, which the revision
check reads anyway, so they're loaded eagerly. An attribute that costs its own
lookup can be `Principal.lazy(effect)` instead. It's loaded the first time a
rule or handler reads it, and then kept for the life of the principal, which
is one request.

**Example** (Loading managed units only when a rule needs them, not from the example app)

```ts
class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal.Principal<{
    readonly isSuperAdmin: boolean
    readonly managedUnitIds: Principal.Lazy<ReadonlyArray<string>>
  }>
>()("app/CurrentPrincipal") {}

const UnitRules = Permission.rules(CurrentPrincipal, Unit).action("units:manage", {
  // Rules refer to a lazy attribute like any other
  filter: ({ principal, resource: unit }) =>
    Condition.or(principal.attributes.isSuperAdmin, Condition.oneOf(unit.id, principal.attributes.managedUnitIds))
})

const cara = Principal.make({
  subject: "p-cara",
  attributes: {
    isSuperAdmin: false,
    managedUnitIds: Principal.lazy(loadManagedUnitIds("p-cara"))
  }
})
```

The output below comes from checking two units as Cara, and one as a super
admin:

```
INFO: loading the units p-cara manages
INFO: u-icu: Allow
INFO: u-ed: Deny
INFO: admin u-ed: Allow
```

Cara's list loads once, for the first check. The super admin's list never
loads, because `isSuperAdmin` decides the `or` first.

Handlers read a lazy attribute with `yield*`:

```ts
const unitIds = yield* principal.attributes.managedUnitIds
```

**Details**

- The effect can't require services, so close over them where the principal
  is built.
- If the load fails, the failure is logged and the check fails with
  `PermissionUnavailable`. The failure is kept too, so every check in the
  request gets the same answer.
- A lazy attribute can be at any depth.
- The whole attributes object can be lazy as well, for example
  `Principal.lazy(Effect.all({ ... }))`.
- Passing an effect as an attribute without `Principal.lazy` is a type error,
  because rules would read the effect itself as the value.

# Conditions

A condition is data. `Condition.eq(unit.hospitalId,
principal.attributes.homeHospitalId)` records which fields are compared,
instead of comparing them. That's what lets one condition be:

- checked against a record in memory;
- simplified once the caller is known;
- compiled into SQL.

## Comparing fields

Rules get references to the principal's fields and the resource's fields, and
combine them with these:

| Condition | Holds when |
| --- | --- |
| `eq`, `notEq`, `lt`, `lte`, `gt`, `gte` | the comparison holds |
| `oneOf(value, list)` | the value is in a literal list, or in a list field |
| `isNull(value)`, `isNotNull(value)` | the value is, or isn't, `null` or `undefined` |
| `and(...)`, `or(...)`, `not(...)` | as in SQL |
| `related(relation, subject, object)` | a relation fact exists |
| `custom(name, evaluate)` | an effect returns `true` |
| `always`, `never` | always, or never |

A boolean field can be used as a condition on its own, like
`principal.attributes.isSuperAdmin` below.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
export const UnitRules = Permission.rules(CurrentPrincipal, Unit)
  .action("units:read", {
    filter: ({ principal, resource: unit }) =>
      Condition.or(
        principal.attributes.isSuperAdmin,
        Condition.eq(unit.hospitalId, principal.attributes.homeHospitalId),
        Condition.related(UnitMembership, principal.subject.id, unit.id)
      )
  })
```

## Missing values

Conditions use SQL's three-valued logic, so a check in memory and the compiled
SQL always agree:

- comparing a missing value (`null` or `undefined`) gives unknown;
- `not` of unknown is still unknown;
- a condition that ends up unknown doesn't pass.

**Example** (Negating a comparison with a missing value, not from the example app)

```ts
const notMine = Condition.not(Condition.eq(document.archivedBy, principal.id))
// archivedBy "u-2": true
// archivedBy null: false, because null = "u-1" is unknown

// Say what a missing value means
const notArchivedByMe = Condition.or(Condition.isNull(document.archivedBy), notMine)
// archivedBy null: true
```

## Relations

A relation is a named fact between a subject and an object, such as "this
profile works on this unit". Declaring one says nothing about where the facts
are stored.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
export const UnitMembership = Condition.relation<ProfileId, UnitId>("unit:member")

// In a rule
Condition.related(UnitMembership, principal.subject.id, unit.id)
```

The authorizer answers lookups from a relation store. `PermissionSql` reads
the facts from a table (see [SQL](#sql)), and
`Authorizer.layerRelationsMemory` holds them in memory for tests (see
[Relation stores](#relation-stores)).

## Custom conditions

When a rule can't be data, such as a check that calls another service,
`Condition.custom` runs an effect with the real principal and resource.

**Example** (Asking a shift schedule service, not from the example app)

```ts
class ShiftSchedule extends Context.Service<ShiftSchedule, {
  readonly isOnShift: (profileId: ProfileId, unitId: UnitId) => Effect.Effect<boolean>
}>()("app/ShiftSchedule") {}

const onShift = Condition.custom(
  "on shift",
  ({ principal, resource: swap }: {
    readonly principal: Principal.Authenticated<Member, ProfileId>
    readonly resource: SwapRequest
  }) => ShiftSchedule.use((schedule) => schedule.isOnShift(principal.subject.id, swap.unitId))
)
```

**Details**

- The services a custom condition needs become requirements of
  `Permissions.layer`, which here is `Layer<Authorizer, never, ShiftSchedule>`.
- Custom conditions run last, and only if the rest of the rule hasn't already
  decided the result.
- They can't be compiled to SQL, so keep them off actions used to filter
  lists.
- If one fails, the check fails with `PermissionUnavailable`. A failure is
  never an allow or a deny.

## Evaluating and simplifying

Applications rarely call these directly. `Permissions` and `PermissionSql`
call them, and everything else is built on them.

- `Condition.evaluate` checks a condition against real values.
- `Condition.simplify` fills in the principal's values and folds whatever
  becomes known, leaving a condition over resource fields only.

**Example** (Not from the example app)

```ts
const { principal, resource } = Condition.refs<{ readonly hospitalId: string }, { readonly hospitalId: string }>()
const sameHospital = Condition.eq(resource.hospitalId, principal.hospitalId)

yield* Condition.evaluate(sameHospital, { principal: { hospitalId: "h-1" }, resource: { hospitalId: "h-1" } })
// true

yield* Condition.simplify(sameHospital, { hospitalId: "h-1" })
// the same as Condition.eq(resource.hospitalId, "h-1")
```

If a condition simplifies to `Condition.never`, no resource could pass. That's
how the middleware turns callers away before the handler runs.

# Rules

`Permission.rules(Principal, Resource)` starts the rules for one resource
type, and each method declares one action. The rule functions run once, when
the action is declared, and receive references rather than values.

## Actions on existing resources

`.action(name, { filter })` declares an action on resources that already
exist. `filter` says which of them the caller may act on.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
export const SwapRules = Permission.rules(CurrentPrincipal, SwapRequest)
  .action("swaps:read", {
    filter: ({ principal, resource: swap }) =>
      Condition.or(
        Condition.eq(swap.requesterId, principal.subject.id),
        Condition.eq(swap.recipientId, principal.subject.id),
        Condition.and(
          principal.attributes.managesSwaps,
          Condition.related(UnitMembership, principal.subject.id, swap.unitId)
        )
      )
  })
  .action("swaps:accept", {
    filter: ({ principal, resource: swap }) =>
      Condition.and(Condition.eq(swap.recipientId, principal.subject.id), Condition.eq(swap.status, "pending"))
  })
```

## Reusing another action's filter

`allowed(name)` returns the filter of an action declared earlier for the same
resource. Only earlier actions can be named, so rules can't refer to each
other in a loop.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
.action("units:update", {
  // Units you can read, if you manage units
  filter: ({ principal, allowed }) => Condition.and(allowed("units:read"), principal.attributes.managesUnits),
  check: ({ allowed }) => allowed("units:read")
})
```

## Checking the result of an update

`check` says what a resource must still satisfy after `Permissions.update`
applies a change. Without it, `filter` is used. In the `units:update` rule
above, `check` means a manager can rename a unit but can't move it out of
their own reach. [`update`](#update) shows it working.

## Forbidding

`forbid` denies the action, whatever `filter` and `check` say. The example app uses
it so that support staff can look at a swap while acting as a manager, but
can't approve it.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
.action("swaps:approve", {
  filter: ({ principal, resource: swap }) =>
    Condition.and(
      Condition.eq(swap.status, "accepted"),
      Condition.notEq(swap.requesterId, principal.subject.id),
      principal.attributes.managesSwaps,
      Condition.related(UnitMembership, principal.subject.id, swap.unitId)
    ),
  forbid: ({ principal }) => Condition.isNotNull(principal.actor)
})
```

```ts
yield* Permissions.can("swaps:approve", acceptedSwap) // as Cara
// { _tag: "Allow", action: "swaps:approve", ... }

yield* Permissions.can("swaps:approve", acceptedSwap) // as Eve, acting as Cara
// { _tag: "Deny", action: "swaps:approve", reason: "Forbidden" }
```

## Create actions

`.create(name, { check, set })` declares an action that creates resources.
There's nothing to filter yet, so the rule is a `check` on the new value
instead.

`set` fills in fields the client isn't allowed to send. For a `Model` class,
the client sends the `jsonCreate` variant, and the value that's checked and
written is the `insert` variant. `set` must fill every field that `insert`
needs and `jsonCreate` doesn't have, or the rule doesn't compile.

**Example** (From [`src/domain/SwapRequest.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/domain/SwapRequest.ts) and [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
export class SwapRequest extends Model.Class<SwapRequest>("SwapRequest")({
  id: Model.UuidV4Insert(SwapRequestId),
  unitId: UnitId,
  recipientId: ProfileId,
  // GeneratedByApp fields are left out of jsonCreate, so clients can't send them
  requesterId: Model.GeneratedByApp(ProfileId),
  status: Model.GeneratedByApp(SwapStatus),
  createdAt: Model.DateTimeInsert
}) {}

.create("swaps:create", {
  set: ({ principal }) => ({ requesterId: principal.subject.id, status: "pending" }),
  // Checked on SwapRequest.insert, the value that will be written
  check: ({ principal, resource: swap }) => Condition.related(UnitMembership, principal.subject.id, swap.unitId)
})
```

Leaving `status` out of `set` is a compile error:

```
Property 'status' is missing in type '{ requesterId: string & Brand<"ProfileId">; }'
but required in type 'RequiredPresets<typeof SwapRequest>'.
```

**Details**

- `set` runs only for signed-in principals. The system principal has no
  subject to fill in, so it passes those fields in the payload itself.
- For a plain `Schema.Class`, the payload is the class's constructor input,
  and `set` is optional.

## Combining rule sets

`Permission.make` combines rule sets into the app's `Permissions` object.
`aliases` names groups of actions for use in limits, and an alias may stand
for other aliases.

**Example** (From [`src/permissions/Permissions.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/permissions/Permissions.ts))

```ts
export const Permissions = Permission.make(CurrentPrincipal, {
  rules: [UnitRules, SwapRules],
  aliases: {
    // Links sent by text message carry swaps:respond
    "swaps:respond": ["swaps:read", "swaps:accept"]
  }
})
```

Declaring an action twice in one rule set is a type error. Declaring it in two
rule sets is a defect when `Permission.make` runs.

# Checking permissions in handlers

The `Permissions` object is how handlers use the rules. Each method reads the
principal from the app's principal service and asks the `Authorizer`.

## `can`

`can` returns a decision without failing. Use it for things like showing or
hiding a button.

**Example** (Decisions for the seeded profiles)

```ts
const icu = yield* units.findById(UnitId.make("u-icu"))

yield* Permissions.can("units:read", icu) // as Ana
// { _tag: "Allow", action: "units:read", ... }

yield* Permissions.can("units:update", icu) // as Ana, who doesn't manage units
// { _tag: "Deny", action: "units:update", reason: "NoPermission" }

yield* Permissions.can("units:read", icu) // as a guest
// { _tag: "Deny", action: "units:read", reason: "Unauthenticated" }

yield* Permissions.can("units:update", icu) // as Principal.system("nightly-import")
// { _tag: "Allow", action: "units:update", ... }
```

`Authorizer.isAllow(decision)` narrows a decision to `Allow`.

## `require`

`require` fails unless the action is allowed, with `Unauthenticated` for a
guest and `PermissionDenied` for anyone else. It returns the resource branded
as `Permission.Authorized<Action, Resource>`.

**Example** (From [`src/server/Http.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Http.ts))

```ts
approve: Effect.fn(function*({ params }) {
  const swap = yield* swaps.findById(params.id)
  return yield* swaps.approve(yield* Permissions.require("swaps:approve", swap))
})
```

The brand lets a service insist on a check. `Swaps.approve` only takes a swap
that passed `swaps:approve`:

```ts
// src/server/Swaps.ts
approve(swap: Permission.Authorized<"swaps:approve", SwapRequest>): Effect.Effect<SwapRequest>
```

Calling it with a swap that hasn't been checked doesn't compile:

```
Argument of type 'SwapRequest' is not assignable to parameter of type
'Authorized<"swaps:approve", SwapRequest>'.
```

The brand exists only in types. Nothing is copied or marked at runtime.

Action names are checked too. A typo such as
`Permissions.require("swaps:aprove", swap)` is a compile error that lists the
actions that exist.

## `filter`

`filter(action)` returns the condition a resource must satisfy for the caller
to perform the action, with the caller's values filled in. It's what
`PermissionSql` compiles into a `WHERE` clause (see
[Filtering a list](#filtering-a-list)). If the caller could never perform the
action, it returns `Condition.never`.

## `create`

`create(action, payload)` builds the new value from the payload and `set`,
checks it, and returns it branded and ready for the repository.

**Example** (From [`src/server/Http.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Http.ts) and [`src/server/Swaps.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Swaps.ts))

```ts
create: Effect.fn(function*({ payload }) {
  // payload is SwapRequest.jsonCreate
  const draft = yield* Permissions.create("swaps:create", payload)
  return yield* swaps.insert(draft)
})

insert(draft: Permission.Authorized<"swaps:create", typeof SwapRequest.insert.Type>): Effect.Effect<SwapRequest>
```

Ana creates a swap with `{ unitId: "u-icu", recipientId: "p-ben" }` and gets:

```json
{
  "id": "338854fd-5a19-4909-8dc1-10a3b81126dd",
  "unitId": "u-icu",
  "recipientId": "p-ben",
  "requesterId": "p-ana",
  "status": "pending",
  "createdAt": "2026-11-06T18:01:53.411Z"
}
```

`id` and `createdAt` come from the `insert` variant, and `requesterId` and
`status` come from `set`.

## `update`

`update(action, resource, patch)` does three things, in order:

1. Checks the resource as it is now, with `filter`.
2. Builds the `update` variant from the row, the patch and `set`.
3. Checks the resource as it would be after the change, with `check`.

**Example** (From [`src/server/Http.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Http.ts))

```ts
rename: Effect.fn(function*({ params, payload }) {
  const unit = yield* units.findById(params.id)
  const renamed = yield* Permissions.update("units:update", unit, { name: payload.name })
  return yield* units.save(renamed)
})
```

As Cara, renaming the ICU works. The second call below moves the Emergency
unit to another hospital, using `update` directly rather than through the API.
It's denied, because Cara only reaches that unit through her own hospital:

```ts
yield* Permissions.update("units:update", icu, { name: "Intensive Care" })
// {"id":"u-icu","hospitalId":"h-st-marys","name":"Intensive Care"}

yield* Permissions.update("units:update", emergency, { hospitalId: HospitalId.make("h-riverside") })
// fails with {"_tag":"PermissionDenied","action":"units:update","reason":"NoPermission"}
```

Moving the ICU the same way would work, because Cara is a member of it, so it
stays in reach.

# The Authorizer

`Authorizer` is the service that makes every decision. Handlers never call it
directly; they go through `Permissions`. It has three operations:

- `check` decides on one resource, using `filter`.
- `checkWrite` decides on one value being written, using `check`.
- `plan` decides with no resource. It returns the condition a resource must
  satisfy.

When the authorizer can't decide, the check fails with
`PermissionUnavailable`. It never turns into an allow or a deny.

## The in-process authorizer

`Permissions.layer` evaluates the rules in process. It needs a relation store
for `related` conditions. The example app's store comes from `PermissionsSql.layer`,
so the two layers are provided together.

**Example** (From [`src/server/App.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/App.ts))

```ts
const AuthorizerLayer = Permissions.layer.pipe(Layer.provideMerge(PermissionsSql.layer))
```

The in-process authorizer:

- denies guests and allows the system before it looks at any rules;
- checks limits, expanding aliases;
- lets `forbid` override `filter` and `check`;
- records each decision on the current span, as `permission.action`,
  `permission.decision` and `permission.reason`.

## Relation stores

Without a relation store, every relation lookup fails with
`PermissionUnavailable`. For tests, keep the facts in memory:

```ts
const memberships = [
  UnitMembership.of(ProfileId.make("p-ana"), UnitId.make("u-icu")),
  UnitMembership.of(ProfileId.make("p-cara"), UnitId.make("u-icu"))
]

const TestAuthorizer = Permissions.layer.pipe(Layer.provide(Authorizer.layerRelationsMemory(memberships)))
```

## Layers for tests

`Authorizer.layerDenyAll` denies every request, and
`Authorizer.layerUnsafeAllowAll` allows every request. They're for tests and
prototypes.

## Other engines

The `Authorizer` is where you swap in a different engine. A layer that sends
decisions to an external engine would be another implementation of the same
service, and nothing else would change. No such adapter exists yet.

# Errors

| Error | Status | When |
| --- | --- | --- |
| `Unauthenticated` | 401 | a guest asked for a protected action |
| `PermissionDenied` | 403 | a signed-in caller isn't allowed; `reason` is `NoPermission`, `Forbidden` or `Limit` |
| `PermissionUnavailable` | 503 | no decision could be made, for example because a relation lookup failed |

They're Schema errors, so clients decode them. Here's what they look like over
HTTP:

```
GET /units            no token   401  {"_tag":"Unauthenticated","action":"units:read"}
PATCH /units/u-icu    as Ana     403  {"_tag":"PermissionDenied","action":"units:update","reason":"NoPermission"}
```

The module exports them two ways:

- `PermissionError.errors` is a list, for `HttpApiMiddleware`. Each error
  keeps its status. A union schema would lose them, and respond with 500.
- `PermissionError.PermissionError` is one union schema, for `RpcMiddleware`,
  which takes a single error schema.

# Middleware

`PermissionMiddleware` enforces rules at endpoints and RPCs. For each request,
the middleware:

1. reads the action the endpoint requires;
2. lets `Permission.Public` endpoints through;
3. denies an endpoint with no action;
4. asks whether the caller could ever perform the action, on any resource,
   and turns them away with a 401 or 403 if not.

It can only ask whether the caller could ever do it, because it runs before
the handler has loaded anything. Checks on a specific record happen in the
handler, with `require`.

The middleware also provides the `Authorizer` to handlers. So handler code
that calls `Permissions` doesn't add a requirement that the app's layers have
to satisfy.

## HttpApi

Declare an ordinary `HttpApiMiddleware`.

**Example** (From [`src/api/Middleware.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/api/Middleware.ts))

```ts
export class Authorize extends HttpApiMiddleware.Service<
  Authorize,
  {
    requires: CurrentPrincipal
    provides: Authorizer.Authorizer
  }
>()("examples/Authorize", {
  error: PermissionError.errors
}) {}
```

Annotate each endpoint with the action it requires. A typo in the action name
doesn't compile.

**Example** (From [`src/api/Api.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/api/Api.ts))

```ts
export class SwapsGroup extends HttpApiGroup.make("swaps")
  .add(
    HttpApiEndpoint.get("list", "/swaps", {
      success: Schema.Array(SwapRequest.json)
    }).annotate(Permissions.Required, "swaps:read"),
    HttpApiEndpoint.post("approve", "/swaps/:id/approve", {
      params: { id: SwapRequestId },
      success: SwapRequest.json,
      error: SwapNotFound
    }).annotate(Permissions.Required, "swaps:approve")
  )
  .middleware(Authorize)
  .middleware(Authentication)
{}
```

`Authorize` needs the principal, so it's added first. `Authentication`
provides the principal, so it's added last, and wraps `Authorize`.

Then implement the middleware.

**Example** (From [`src/server/Http.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Http.ts))

```ts
export const AuthorizeLayer = PermissionMiddleware.layerHttpApi(Authorize, Permissions, { api: Api })
```

## Public endpoints

`Permission.Public` marks an endpoint that needs no permission, so guests can
reach it.

**Example** (From [`src/api/Api.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/api/Api.ts))

```ts
HttpApiEndpoint.get("health", "/health", {
  success: Schema.String
}).annotate(Permissions.Required, Permission.Public)
```

## Checking the API at startup

With `{ api }`, the layer checks every endpoint when it's built. It fails if
any endpoint:

- has no action;
- requires an action that doesn't exist;
- requires an action but isn't behind the middleware.

**Example** (Two mistakes, not from the example app)

```ts
const Api = HttpApi.make("broken")
  .add(
    HttpApiGroup.make("swaps").add(
      HttpApiEndpoint.get("list", "/swaps", { success: Schema.String })
        .annotate(Permissions.Required, "swaps:read"),
      // No action
      HttpApiEndpoint.post("cancel", "/swaps/:id/cancel", { success: Schema.String })
    ).middleware(Authorize)
  )
  .add(
    // Requires an action, but the group has no Authorize middleware
    HttpApiGroup.make("reports").add(
      HttpApiEndpoint.get("export", "/reports", { success: Schema.String })
        .annotate(Permissions.Required, "swaps:read")
    )
  )
```

```
PermissionMiddleware.layerHttpApi:
  swaps.cancel has no required action; annotate it with an action or Permission.Public
  reports.export requires "swaps:read" but is not guarded by examples/Authorize
```

`PermissionMiddleware.validateHttpApi(Api, Authorize, Permissions)` returns
the same list, which is handy in a test.

Annotations on the whole `HttpApi` never reach middleware, so put them on
groups or endpoints instead.

## RPC

RPC works the same way, with `RpcMiddleware`.

**Example** (From [`src/rpc/SwapRpcs.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/rpc/SwapRpcs.ts) and [`src/server/Rpc.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Rpc.ts))

```ts
export class RpcAuthorize extends RpcMiddleware.Service<
  RpcAuthorize,
  {
    requires: CurrentPrincipal
    provides: Authorizer.Authorizer
  }
>()("examples/RpcAuthorize", {
  error: PermissionError.PermissionError
}) {}

export const ApproveSwap = Rpc.make("ApproveSwap", {
  payload: { id: SwapRequestId },
  success: SwapRequest.json,
  error: SwapNotFound
}).annotate(Permissions.Required, "swaps:approve")

export const RpcAuthorizeLayer = PermissionMiddleware.layerRpc(RpcAuthorize, Permissions, { group: SwapRpcs })

// The handler checks the swap itself, as over HTTP
ApproveSwap: Effect.fn(function*({ id }) {
  const swap = yield* swaps.findById(id)
  return yield* swaps.approve(yield* Permissions.require("swaps:approve", swap))
})
```

There are two differences from HttpApi:

- RPC middleware takes one error schema, so it declares the union.
- RPC middleware only sees annotations on the RPC itself. To annotate a whole
  group, push the annotations down with `RpcGroup.annotateRpcs`.

Handlers may fail with their middleware's errors, so each RPC declares only
its own errors, such as `SwapNotFound` here.

# SQL

`PermissionSql` turns rules into SQL, so a list query returns only what the
caller may see. It takes one query, and pages stay full.

## Declaring the service

**Example** (From [`src/server/PermissionsSql.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/PermissionsSql.ts))

```ts
export class PermissionsSql extends PermissionSql.Service<PermissionsSql>()("examples/PermissionsSql", {
  permissions: Permissions,
  tables: [PermissionSql.table(Unit, "units"), PermissionSql.table(SwapRequest, "swap_requests")],
  relations: [
    PermissionSql.relation(UnitMembership, { table: "profile_units", subject: "profile_id", object: "unit_id" })
  ]
}) {}
```

**Details**

- **`table`** maps a resource schema to its table.
  - Fields map to columns by name, so the SQL client's name transforms still
    apply. The example app's client turns `hospitalId` into `hospital_id`.
  - Pass column names for any fields that differ, as in
    [Getting Started](#getting-started).
- **`relation`** maps a relation to the table that stores its facts.
- **The layer** closes over the SQL client and the mappings, so the
  service's methods never require them. It also provides the relation store,
  which is why it's provided to the authorizer too (see
  [The in-process authorizer](#the-in-process-authorizer)).

## Filtering a list

**Example** (From [`src/server/Units.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/Units.ts))

```ts
const list = Effect.fn("Units.list")(function*() {
  const visible = yield* permissionsSql.filter("units:read")
  return yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: Unit,
    execute: () => sql`SELECT * FROM units WHERE ${visible} ORDER BY name`
  })().pipe(Effect.orDie)
})
```

Here's what the rules compile to for some of the seeded profiles.

`units:read` for Ana:

```sql
SELECT * FROM "units" WHERE ("units"."hospital_id" = ? OR EXISTS (SELECT 1 FROM "profile_units" AS "permission_relation_0" WHERE "permission_relation_0"."profile_id" = ? AND "permission_relation_0"."unit_id" = "units"."id"))
-- ["h-st-marys", "p-ana"]
```

`units:read` for Dev, a super admin:

```sql
SELECT * FROM "units" WHERE 1=1
```

`swaps:approve` for Ana, who doesn't manage swaps:

```sql
SELECT * FROM "swap_requests" WHERE 1=0
```

`swaps:approve` for Cara:

```sql
SELECT * FROM "swap_requests" WHERE ("swap_requests"."status" = ? AND "swap_requests"."requester_id" <> ? AND EXISTS (SELECT 1 FROM "profile_units" AS "permission_relation_0" WHERE "permission_relation_0"."profile_id" = ? AND "permission_relation_0"."unit_id" = "swap_requests"."unit_id"))
-- ["accepted", "p-cara", "p-cara"]
```

Here's what happened:

- **The caller's values are filled in first.**
  - `isSuperAdmin` is false for Ana, so that part of the `or` drops out.
  - For Dev it's true, so the whole condition is `1=1`.
- **Filters deny by default.**
  - `managesSwaps` is false for Ana, so `swaps:approve` can never hold, and it
    compiles to `1=0`.
  - An empty `or` is `1=0` too.
- **Relations become `EXISTS` subqueries** against their table.
- **Columns are qualified with the table name.**

[`test/filter.test.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/test/filter.test.ts) checks, for every profile, that
the compiled filter returns exactly the swaps the single-record check allows.

## Relation lookups

For a single-record check, the authorizer asks the relation store, and
`PermissionsSql` runs the lookup.

Lookups that run at the same time share one query per relation table. That
happens when you check a page of records with
`Effect.forEach(records, check, { concurrency: "unbounded" })`, for example.

Lookups inside a transaction are batched separately, so they see that
transaction's writes.

## What can't be compiled

A filter can only refer to the resource's own top-level fields. Compiling any
of these is a defect:

- `Condition.custom`;
- nested fields;
- `oneOf` over a list field;
- a relation with no table mapping.

So keep those off actions that are used to filter lists.

# Putting it together

Here's how the layers are wired in the example app.

**Example** (From [`src/server/App.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/src/server/App.ts))

```ts
// The in-process authorizer for the rules, looking relation facts up in SQL
// through PermissionsSql
const AuthorizerLayer = Permissions.layer.pipe(Layer.provideMerge(PermissionsSql.layer))

const ServicesLayer = Layer.mergeAll(Units.layerNoDeps, Swaps.layerNoDeps, Authenticator.layerNoDeps).pipe(
  Layer.provideMerge(Tokens.layer),
  Layer.provideMerge(AuthorizerLayer),
  Layer.provideMerge(DatabaseLayer)
)

// Handlers, and both middleware, for the HttpApi groups
export const HttpLayer = Layer.mergeAll(UnitsHandlers, SwapsHandlers, SystemHandlers).pipe(
  Layer.provideMerge(Layer.mergeAll(AuthenticationLayer, AuthorizeLayer)),
  Layer.provideMerge(ServicesLayer)
)

// The same for the RPC group
export const RpcLayer = SwapRpcHandlers.pipe(
  Layer.provideMerge(Layer.mergeAll(RpcAuthenticationLayer, RpcAuthorizeLayer)),
  Layer.provideMerge(ServicesLayer)
)
```

# Testing

The tests in [`test/`](https://github.com/jpowersdev/effect-permission-examples/tree/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/test) run the app against a fresh in-memory database.
These patterns are worth copying:

- **Tokens and clients for seeded profiles.**
  [`test/utils.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/test/utils.ts) has `tokenFor(name, { scope, actor })`,
  which issues a real token for a seeded profile, and `clientFor(name)`,
  which gives a typed HttpApi client that sends it.
- **Real status codes.** [`test/status.test.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/test/status.test.ts) checks
  them through a web handler, because the typed client decodes errors by
  their body.
- **SQL against single-record checks.**
  [`test/filter.test.ts`](https://github.com/jpowersdev/effect-permission-examples/blob/fadb6fa4262ed1042bc805cd63cfb3ced1b813a2/test/filter.test.ts) checks that the compiled SQL
  agrees with them.
- **Rules without a database.** To test rules on their own, use
  `Permissions.layer` with `Authorizer.layerRelationsMemory`.
