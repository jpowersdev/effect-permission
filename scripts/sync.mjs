// Copies the permission modules, tests and type tests from the `permission`
// branch of the effect fork, rewriting imports for a standalone package, and
// the walkthrough from the examples repo.
//
//   node scripts/sync.mjs [--repo <effect checkout>] [--ref <git ref>]
//     [--examples <examples checkout>] [--examples-ref <git ref>] [--check]
//
// The fork and the examples repo are the source of truth: edit there, then
// sync. With `--check`, nothing is written and the script fails if the files
// differ.
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs"
import * as Os from "node:os"
import * as Path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
  options: {
    repo: { type: "string", default: Path.join(Os.homedir(), "github.com/effect-ts/effect") },
    ref: { type: "string", default: "permission" },
    examples: { type: "string", default: Path.join(Os.homedir(), "github.com/jpowersdev/effect-permission-examples") },
    "examples-ref": { type: "string", default: "main" },
    check: { type: "boolean", default: false }
  }
})

const root = Path.resolve(import.meta.dirname, "..")
const gitIn = (repo) => (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
const git = gitIn(values.repo)
const commit = git("rev-parse", values.ref).trim()
const list = (dir) => git("ls-tree", "--name-only", `${commit}:${dir}`).split("\n").filter((name) => name.endsWith(".ts"))
const read = (path) => git("show", `${commit}:${path}`)

const examplesGit = gitIn(values.examples)
const examplesCommit = examplesGit("rev-parse", values["examples-ref"]).trim()
const EXAMPLES = "https://github.com/jpowersdev/effect-permission-examples"

const PACKAGE = "@jpowersdev/effect-permission"

// `../Effect.ts` and `../sql/SqlClient.ts` become `effect/Effect` and
// `effect/sql/SqlClient`; JSDoc examples import the package instead of
// `effect/permission`; and `@since` follows this package's versions.
const rewriteSource = (text) =>
  text
    .replace(/from "\.\.\/([^"]+)\.ts"/g, (_, path) => `from "effect/${path}"`)
    .replaceAll(`"effect/permission"`, `"${PACKAGE}"`)
    .replace(/@since 4\.\d+\.\d+/g, "@since 0.1.0")

const rewriteTest = (text) => text.replaceAll(`from "effect/permission"`, `from "../src/index.ts"`)

// Until effect 4.1.3 is released, RPC handlers can only fail with the errors
// their RPC declares (Effect-TS/effect#10418), so the test RPCs declare the
// permission errors, as apps on 4.1.2 have to. Remove this once the package
// requires 4.1.3.
const beforeRpcHandlerErrors = (text) => {
  const patched = text
    .replace(
      "// The RPCs don't repeat the permission errors: handlers may fail with their\n// middleware's errors\n",
      "// On effect 4.1.2, RPC handlers can only fail with errors their RPC declares,\n// so these RPCs repeat the permission errors\n"
    )
    .replaceAll(
      "{ payload: { id: Schema.String }, success: SwapRequest }",
      "{ payload: { id: Schema.String }, success: SwapRequest, error: PermissionError.PermissionError }"
    )
    .replace(
      "        // The middleware lets a manager through, and the handler denies the\n        // pending swap with an error its RPC doesn't declare\n",
      "        // The middleware lets a manager through, and the handler denies the\n        // pending swap\n"
    )
  if (patched.split("PermissionError.PermissionError }").length !== 3) {
    throw new Error("sync: the RPC test changed; update beforeRpcHandlerErrors")
  }
  return patched
}

// The walkthrough lives in the examples repo and refers to the example app's
// files, so its links point there, and it imports this package.
const rewriteWalkthrough = (text) => {
  const replace = (from, to) => {
    if (!text.includes(from)) throw new Error(`sync: the walkthrough changed; update the rewrite of ${JSON.stringify(from)}`)
    text = text.replace(from, to)
  }
  replace(
    "its code comes from this repo, a\nshift-swap API described in the [README](README.md).",
    `its code comes from\n[effect-permission-examples](${EXAMPLES}), a shift-swap API described in its\n[README](README.md).`
  )
  replace(
    "It's\n[`src/getting-started.ts`](src/getting-started.ts), and you can run it with\n`node src/getting-started.ts`.",
    "It's\n[`examples/getting-started.ts`](examples/getting-started.ts) in this repo, and you\ncan run it with `node examples/getting-started.ts` after `npm run build`."
  )
  return [
    "<!-- Synced from jpowersdev/effect-permission-examples by scripts/sync.mjs; edit it there. -->",
    "",
    text
      .replaceAll("effect/permission", PACKAGE)
      .replaceAll("This app", "The example app")
      .replaceAll("this app", "the example app")
      .replace(/\]\(((?:src|test|README)[^)#]*)\)/g, (_, path) =>
        `](${EXAMPLES}/${Path.extname(path) === "" ? "tree" : "blob"}/${examplesCommit}/${path})`)
  ].join("\n")
}

// The one-page example imports the package by name, as an app would
const rewriteExample = (text) => {
  const from = "Run it with\n * `node src/getting-started.ts`."
  if (!text.includes(from)) throw new Error("sync: the getting-started example changed; update rewriteExample")
  return [
    "// Synced from jpowersdev/effect-permission-examples by scripts/sync.mjs; edit it there.",
    text
      .replace(from, "Run it with\n * `node examples/getting-started.ts` after `npm run build`.")
      .replaceAll(`"effect/permission"`, `"${PACKAGE}"`)
  ].join("\n")
}

const files = new Map()
files.set("examples/getting-started.ts", rewriteExample(examplesGit("show", `${examplesCommit}:src/getting-started.ts`)))
files.set("WALKTHROUGH.md", rewriteWalkthrough(examplesGit("show", `${examplesCommit}:WALKTHROUGH.md`)))
for (const name of list("packages/effect/src/permission")) {
  files.set(`src/${name}`, rewriteSource(read(`packages/effect/src/permission/${name}`)))
}
for (const name of list("packages/effect/test/permission")) {
  const text = rewriteTest(read(`packages/effect/test/permission/${name}`))
  files.set(`test/${name}`, name === "PermissionMiddleware.test.ts" ? beforeRpcHandlerErrors(text) : text)
}
files.set("test/PermissionSqlite.test.ts", rewriteTest(read("packages/sql/sqlite-node/test/Permission.test.ts")))
for (const name of list("packages/effect/typetest/permission")) {
  files.set(`typetest/${name}`, rewriteTest(read(`packages/effect/typetest/permission/${name}`)))
}
files.set("SOURCE", `https://github.com/jpowersdev/effect/tree/${commit}\n${EXAMPLES}/tree/${examplesCommit}\n`)

// Files in the synced directories that the fork no longer has
const stale = ["src", "test", "typetest", "examples"].flatMap((dir) =>
  Fs.existsSync(Path.join(root, dir))
    ? Fs.readdirSync(Path.join(root, dir)).map((name) => `${dir}/${name}`).filter((path) => !files.has(path))
    : []
)

if (values.check) {
  const differ = [...files].filter(([path, text]) => {
    const file = Path.join(root, path)
    return !Fs.existsSync(file) || Fs.readFileSync(file, "utf8") !== text
  }).map(([path]) => path)
  if (differ.length > 0 || stale.length > 0) {
    console.error(`Out of date with ${values.ref} (${commit.slice(0, 10)}) or the examples (${examplesCommit.slice(0, 10)}):`)
    for (const path of [...differ, ...stale]) console.error(`  ${path}`)
    process.exit(1)
  }
  console.log(`Up to date with ${values.ref} (${commit.slice(0, 10)}) and the examples (${examplesCommit.slice(0, 10)})`)
} else {
  for (const path of stale) Fs.rmSync(Path.join(root, path))
  for (const [path, text] of files) {
    Fs.mkdirSync(Path.dirname(Path.join(root, path)), { recursive: true })
    Fs.writeFileSync(Path.join(root, path), text)
  }
  console.log(`Synced ${files.size - 1} files from ${values.ref} (${commit.slice(0, 10)}) and the examples (${examplesCommit.slice(0, 10)})`)
}
