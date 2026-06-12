import { Command, CommandExecutor } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Data, Effect, Stream } from "effect"

export class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}> {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode}: ${this.stderr || this.stdout}`
  }
}

/** Run host commands, capturing stdout. CommandFailed on nonzero exit. */
export class Sh extends Effect.Service<Sh>()("Sh", {
  dependencies: [NodeContext.layer],
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor

    const run = (cmd: string, ...args: Array<string>) =>
      Effect.gen(function* () {
        const process = yield* executor.start(Command.make(cmd, ...args))
        const collect = (stream: typeof process.stdout) =>
          stream.pipe(Stream.decodeText(), Stream.runFold("", (a, b) => a + b))
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [process.exitCode, collect(process.stdout), collect(process.stderr)],
          { concurrency: 3 },
        )
        if (exitCode !== 0) {
          return yield* new CommandFailed({
            command: [cmd, ...args].join(" "),
            exitCode,
            stderr: stderr.trim(),
            stdout: stdout.trim(),
          })
        }
        return stdout
      }).pipe(
        Effect.scoped,
        // PlatformError (spawn/stream failures) is a defect; CommandFailed is the domain error
        Effect.catchAll((e) => (e._tag === "CommandFailed" ? Effect.fail(e) : Effect.die(e))),
      )

    return { run }
  }),
}) {}
