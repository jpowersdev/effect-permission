// Packs the built package and uses it from a fresh project, the way an app
// installing it from npm would: type-checks a consumer against the published
// declarations and runs it against the published JavaScript.
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"

const root = Path.resolve(import.meta.dirname, "..")
const pkg = JSON.parse(Fs.readFileSync(Path.join(root, "package.json"), "utf8"))
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })

const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "effect-permission-dist-"))
try {
  const tarball = run("npm", ["pack", "--silent", "--pack-destination", dir], root).trim().split("\n").at(-1)
  Fs.writeFileSync(
    Path.join(dir, "package.json"),
    JSON.stringify({
      name: "consumer",
      private: true,
      type: "module",
      dependencies: {
        [pkg.name]: `file:./${tarball}`,
        effect: pkg.devDependencies.effect
      }
    })
  )
  Fs.writeFileSync(
    Path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        types: []
      },
      include: ["consumer.ts"]
    })
  )
  const consumer = `import { Context, Effect, Schema } from "effect"
import { Authorizer, Condition, Permission, Principal } from "${pkg.name}"
import * as PermissionError from "${pkg.name}/PermissionError"

class CurrentPrincipal extends Context.Service<
  CurrentPrincipal,
  Principal.Principal<{ readonly isAdmin: boolean }>
>()("consumer/CurrentPrincipal") {}

class Document extends Schema.Class<Document>("Document")({
  id: Schema.String,
  ownerId: Schema.String
}) {}

const DocumentRules = Permission.rules(CurrentPrincipal, Document)
  .action("documents:read", {
    filter: ({ principal, resource: document }) =>
      Condition.or(principal.attributes.isAdmin, Condition.eq(document.ownerId, principal.subject.id))
  })

const Permissions = Permission.make(CurrentPrincipal, { rules: [DocumentRules] })

const program = Effect.gen(function*() {
  const own = yield* Permissions.can("documents:read", new Document({ id: "d-1", ownerId: "u-1" }))
  const other = yield* Permissions.can("documents:read", new Document({ id: "d-2", ownerId: "u-2" }))
  const denied = yield* Effect.flip(Permissions.require("documents:read", new Document({ id: "d-2", ownerId: "u-2" })))
  return [own._tag, other._tag, denied instanceof PermissionError.PermissionDenied, Authorizer.isAllow(own)].join(" ")
}).pipe(
  Effect.provideService(CurrentPrincipal, Principal.make({ subject: "u-1", attributes: { isAdmin: false } })),
  Effect.provide(Permissions.layer)
)

const result = await Effect.runPromise(program)
if (result !== "Allow Deny true true") throw new Error(\`unexpected result: \${result}\`)
console.log(result)
`
  Fs.writeFileSync(Path.join(dir, "consumer.ts"), consumer)
  run("npm", ["install", "--silent", "--no-audit", "--no-fund"], dir)
  run(Path.join(root, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], dir)
  // Node runs the consumer with its types stripped, against the packed JavaScript
  const output = run("node", ["consumer.ts"], dir).trim()
  const files = run("npm", ["pack", "--dry-run", "--json"], root)
  const count = JSON.parse(files)[0].files.length
  console.log(`dist OK: ${tarball} (${count} files), consumer printed "${output}"`)
} finally {
  Fs.rmSync(dir, { recursive: true, force: true })
}
