import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { defineSecretProviderDriver } from "@t3tools/secret-provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath, resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/process";

import {
  definition,
  parseKeePassXcReference,
  type KeePassXcSecretProviderConfig,
} from "../shared/definition.ts";

const KEEPASSXC_CLI = "keepassxc-cli";
// Nobody unlocks anything, so this only bounds a slow key derivation or a wedged CLI.
const READ_TIMEOUT = Duration.seconds(30);
// Each read derives the database key again, which can take a second and tens of MB.
const READ_CONCURRENCY = 4;
// A password file holds one short line; a bigger one, or one that is not a regular file, could never be.
const MAX_PASSWORD_FILE_BYTES = 4096;

const encoder = new TextEncoder();

const installLocations = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") {
    const home = yield* HostProcess.HomeDirectory;
    return [
      "/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli",
      `${home}/Applications/KeePassXC.app/Contents/MacOS/keepassxc-cli`,
    ];
  }
  if (platform === "win32") {
    const env = yield* HostProcess.Environment;
    return [
      `${env.ProgramFiles ?? "C:\\Program Files"}\\KeePassXC\\keepassxc-cli.exe`,
      ...(env.LOCALAPPDATA ? [`${env.LOCALAPPDATA}\\Programs\\KeePassXC\\keepassxc-cli.exe`] : []),
    ];
  }
  return [];
});

const findCli = Effect.fn("KeePassXcDriver.findCli")(function* (cliPath: string | undefined) {
  if (cliPath !== undefined) return cliPath;
  const onPath = yield* resolveCommandPath(KEEPASSXC_CLI).pipe(Effect.provide(Path.layer));
  if (onPath !== null) return onPath;
  const fileSystem = yield* FileSystem.FileSystem;
  for (const location of yield* installLocations) {
    if (yield* fileSystem.exists(location).pipe(Effect.orElseSucceed(() => false))) return location;
  }
  return undefined;
});

// The CLI reads one line from stdin, so a password file may end in a newline but hold no other.
const readPassword = Effect.fn("KeePassXcDriver.readPassword")(function* (passwordFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // A FIFO would never finish the read and a device such as /dev/zero never ends it.
  const info = yield* fileSystem.stat(passwordFile);
  if (info.type !== "File" || info.size > ByteSize.bytes(MAX_PASSWORD_FILE_BYTES)) return undefined;
  const contents = yield* fileSystem.readFileString(passwordFile);
  const password = contents.replace(/\r?\n$/, "");
  return password.length === 0 || /[\r\n]/.test(password) ? undefined : password;
});

// Without `-q` the CLI explains failures on stderr (beside its prompt); the reason is logged, not stderr.
const FAILURE_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid credentials/i, "wrong-credentials"],
  [/failed to load key file/i, "key-file-unreadable"],
  [/failed to open database/i, "database-unreadable"],
  [/could not find entry/i, "entry-not-found"],
  [/unknown attribute/i, "unknown-attribute"],
];
const failureReason = (stderr: string) =>
  FAILURE_REASONS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "cli-error";

const readOne = Effect.fn("KeePassXcDriver.readOne")(function* (
  cli: string,
  config: KeePassXcSecretProviderConfig,
  password: string | undefined,
  reference: string,
) {
  const target = parseKeePassXcReference(reference);
  if (target === undefined) return undefined;
  const spawnCommand = yield* resolveSpawnCommand(cli, [
    "show",
    "--show-protected",
    `--attributes=${target.attribute}`,
    ...(config.keyFile === undefined ? [] : [`--key-file=${config.keyFile}`]),
    ...(password === undefined ? ["--no-password"] : []),
    "--",
    config.database,
    target.entry,
  ]);
  const result = yield* spawnAndCollect(
    cli,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      shell: spawnCommand.shell,
      stdin: password === undefined ? "ignore" : Stream.make(encoder.encode(`${password}\n`)),
    }),
  );
  if (result.code !== 0) {
    yield* Effect.logWarning("Could not read secret from KeePassXC", {
      stage: "show",
      exitCode: result.code,
      reason: failureReason(result.stderr),
    });
    return undefined;
  }
  // The CLI ends each attribute with a newline; anything else is part of the secret.
  const value = result.stdout.replace(/\r?\n$/, "");
  return value.trim().length > 0 ? value : undefined;
});

const recover = <A, E extends { readonly _tag: string }, R>(
  stage: "find-cli" | "password-file" | "show",
  effect: Effect.Effect<A | undefined, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not run KeePassXC", { stage, error: error._tag }).pipe(
        Effect.as(undefined),
      ),
    ),
  );

export const driver = defineSecretProviderDriver({
  kind: definition.kind,
  definition,
  read: Effect.fn("KeePassXcDriver.read")(function* (config, references) {
    const values: Array<string | undefined> = references.map(() => undefined);
    const cli = yield* recover("find-cli", findCli(config.cliPath));
    if (cli === undefined) {
      yield* Effect.logWarning("Could not find keepassxc-cli", { stage: "find-cli" });
      return values;
    }
    // One deadline covers the password file and the reads, so a blocking file cannot wedge this.
    const outcome = yield* Effect.gen(function* () {
      let password: string | undefined;
      if (config.passwordFile !== undefined) {
        password = yield* recover("password-file", readPassword(config.passwordFile));
        if (password === undefined) return false;
      }
      yield* Effect.forEach(
        references,
        (reference, index) =>
          recover("show", readOne(cli, config, password, reference)).pipe(
            Effect.map((value) => {
              values[index] = value;
            }),
          ),
        { concurrency: READ_CONCURRENCY, discard: true },
      );
      return true;
    }).pipe(Effect.timeoutOption(READ_TIMEOUT));
    if (Option.isSome(outcome) && !outcome.value) {
      yield* Effect.logWarning("Could not read the KeePassXC password file", {
        stage: "password-file",
      });
      return values;
    }
    if (Option.isNone(outcome)) {
      yield* Effect.logWarning("KeePassXC did not answer in time", {
        references: references.length,
      });
    }
    return values;
  }),
});
