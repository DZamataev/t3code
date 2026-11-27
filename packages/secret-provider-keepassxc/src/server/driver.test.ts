import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { KeePassXcPath, type KeePassXcSecretProviderConfig } from "../shared/definition.ts";
import { driver } from "./driver.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const path = KeePassXcPath.make;
const CLI = "/opt/keepassxc/keepassxc-cli";
const MAC_APP_CLI = "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli";

const keyFileOnly: KeePassXcSecretProviderConfig = {
  database: path("/home/deck/t3.kdbx"),
  keyFile: path("/home/deck/.config/t3.keyx"),
  cliPath: path(CLI),
};

type CliResult = {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  readonly hang?: boolean;
};

interface Invocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | "ignore";
}

function fakeCli(
  answer: (args: ReadonlyArray<string>) => CliResult,
  files: Readonly<Record<string, string>> = {},
) {
  const invocations: Array<Invocation> = [];
  const spawned = Deferred.makeUnsafe<void>();
  const layer = Layer.mergeAll(
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const { args, options } = command as ChildProcess.StandardCommand;
          const stdin = options.stdin;
          invocations.push({
            command: (command as ChildProcess.StandardCommand).command,
            args: args as ReadonlyArray<string>,
            stdin: Stream.isStream(stdin)
              ? (yield* Stream.runCollect(stdin)).map((chunk) => decoder.decode(chunk)).join("")
              : "ignore",
          });
          Deferred.doneUnsafe(spawned, Effect.void);
          const result = answer(args as ReadonlyArray<string>);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: result.hang
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(encoder.encode(result.stdout ?? "")),
            stderr: Stream.make(encoder.encode(result.stderr ?? "")),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }).pipe(Effect.orDie),
      ),
    ),
    NodeCrypto.layer,
    FileSystem.layerNoop({
      exists: (file) => Effect.succeed(Object.hasOwn(files, file)),
      readFileString: (file) =>
        Object.hasOwn(files, file)
          ? Effect.succeed(files[file]!)
          : Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readFileString",
                pathOrDescriptor: file,
              }),
            ),
    }),
  );
  return { layer, invocations, spawned };
}

const entryOf = (args: ReadonlyArray<string>) => args.at(-1);

describe("KeePassXC driver", () => {
  it.effect("reads an entry's password with the key file alone", () => {
    const cli = fakeCli(() => ({ stdout: "sk-live\n" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(keyFileOnly, ["keepassxc://Codex/oneclick"]), [
        "sk-live",
      ]);
      assert.deepStrictEqual(cli.invocations, [
        {
          command: CLI,
          args: [
            "show",
            "--show-protected",
            "--attributes=password",
            "--key-file=/home/deck/.config/t3.keyx",
            "--no-password",
            "--",
            "/home/deck/t3.kdbx",
            "Codex/oneclick",
          ],
          stdin: "ignore",
        },
      ]);
    }).pipe(Effect.provide(cli.layer));
  });

  it.effect("unlocks with the password file on stdin and reads a named attribute", () => {
    const cli = fakeCli(() => ({ stdout: "deck-user\n" }), { "/run/t3/kpxc.pw": "hunter2\n" });
    return Effect.gen(function* () {
      const values = yield* driver.read(
        { database: path("/t3.kdbx"), passwordFile: path("/run/t3/kpxc.pw"), cliPath: path(CLI) },
        ["keepassxc://Servers/deck#UserName"],
      );

      assert.deepStrictEqual(values, ["deck-user"]);
      assert.deepStrictEqual(cli.invocations[0]?.args, [
        "show",
        "--show-protected",
        "--attributes=UserName",
        "--",
        "/t3.kdbx",
        "Servers/deck",
      ]);
      assert.strictEqual(cli.invocations[0]?.stdin, "hunter2\n");
    }).pipe(Effect.provide(cli.layer));
  });

  it.effect("keeps everything but the newline the CLI adds", () => {
    const cli = fakeCli(() => ({ stdout: " line one\nline two \r\n" }));
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(keyFileOnly, ["keepassxc://Notes#Notes"]), [
        " line one\nline two ",
      ]);
    }).pipe(Effect.provide(cli.layer));
  });

  it.effect("reads each reference on its own, so one missing entry spares the rest", () => {
    const cli = fakeCli((args) =>
      entryOf(args) === "Gone"
        ? { code: 1, stderr: "Could not find entry with path Gone.\n" }
        : entryOf(args) === "Empty"
          ? { stdout: "\n" }
          : { stdout: `${entryOf(args)}-secret\n` },
    );
    return Effect.gen(function* () {
      const values = yield* driver.read(keyFileOnly, [
        "keepassxc://A",
        "keepassxc://Gone",
        "keepassxc://Empty",
        "keepassxc://B",
      ]);

      assert.deepStrictEqual(values, ["A-secret", undefined, undefined, "B-secret"]);
      assert.strictEqual(cli.invocations.length, 4);
    }).pipe(Effect.provide(cli.layer));
  });

  it.effect("reads nothing when the password file is missing or holds more than one line", () => {
    const cli = fakeCli(() => ({ stdout: "sk-live\n" }), { "/two-lines": "a\nb\n" });
    return Effect.gen(function* () {
      for (const passwordFile of ["/missing", "/two-lines"]) {
        assert.deepStrictEqual(
          yield* driver.read(
            { database: path("/t3.kdbx"), passwordFile: path(passwordFile), cliPath: path(CLI) },
            ["keepassxc://A"],
          ),
          [undefined],
        );
      }
      assert.strictEqual(cli.invocations.length, 0);
    }).pipe(Effect.provide(cli.layer));
  });

  it.effect("finds the CLI in the macOS app bundle when it is not on PATH", () => {
    const cli = fakeCli(() => ({ stdout: "sk-live\n" }), { [MAC_APP_CLI]: "" });
    const { cliPath: _, ...withoutCliPath } = keyFileOnly;
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(withoutCliPath, ["keepassxc://A"]), ["sk-live"]);
      assert.strictEqual(cli.invocations[0]?.command, MAC_APP_CLI);
    }).pipe(
      Effect.provide(cli.layer),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
    );
  });

  it.effect("reads nothing when no CLI can be found", () => {
    const cli = fakeCli(() => ({ stdout: "sk-live\n" }));
    const { cliPath: _, ...withoutCliPath } = keyFileOnly;
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* driver.read(withoutCliPath, ["keepassxc://A"]), [undefined]);
      assert.strictEqual(cli.invocations.length, 0);
    }).pipe(
      Effect.provide(cli.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
    );
  });

  it.effect("gives up on a wedged CLI within the read timeout", () => {
    const cli = fakeCli((args) => (entryOf(args) === "Slow" ? { hang: true } : { stdout: "ok\n" }));
    return Effect.gen(function* () {
      const reading = yield* driver
        .read(keyFileOnly, ["keepassxc://Fast", "keepassxc://Slow"])
        .pipe(Effect.forkChild);
      yield* Deferred.await(cli.spawned);
      yield* TestClock.adjust("1 minute");

      assert.deepStrictEqual(yield* Fiber.join(reading), ["ok", undefined]);
    }).pipe(Effect.provide(cli.layer));
  });
});
