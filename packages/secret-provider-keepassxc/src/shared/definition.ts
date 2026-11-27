import { SecretProviderKind } from "@t3tools/contracts";
import { defineSecretProvider } from "@t3tools/secret-provider-core/shared/definition";
import * as Schema from "effect/Schema";

// Absolute on the server, whichever OS it runs: `/…`, `C:\…` or `C:/…`, or a `\\server\share` path.
// That also keeps every path from reading as a CLI option.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\u0000-\u001f]*$/;

export const KeePassXcPath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((value: string) =>
    ABSOLUTE_PATH.test(value) ? true : "Enter an absolute path on the server.",
  ),
).pipe(Schema.brand("KeePassXcPath"));
export type KeePassXcPath = typeof KeePassXcPath.Type;

/** A server can open the database unattended with a key file and an optional password file. */
export const KeePassXcSecretProviderConfig = Schema.Struct({
  database: KeePassXcPath,
  keyFile: KeePassXcPath,
  passwordFile: Schema.optionalKey(KeePassXcPath),
  cliPath: Schema.optionalKey(KeePassXcPath),
});
export type KeePassXcSecretProviderConfig = typeof KeePassXcSecretProviderConfig.Type;

const REFERENCE_PREFIX = "keepassxc://";
const DEFAULT_ATTRIBUTE = "password";
// A name is anything but `/`, `#`, and control characters, and cannot start with `-` or a space.
const NAME = String.raw`[^\s/#\u0000-\u001f-](?:[^/#\u0000-\u001f]*[^\s/#\u0000-\u001f])?`;
const REFERENCE = new RegExp(String.raw`^keepassxc://${NAME}(?:/${NAME})*(?:#${NAME})?$`);
const MAX_REFERENCE_LENGTH = 1024;

export interface KeePassXcEntry {
  /** The entry's path as `keepassxc-cli ls -R` shows it, groups separated by `/`. */
  readonly entry: string;
  readonly attribute: string;
}

/** The entry and attribute a reference names; the attribute defaults to the password. */
export function parseKeePassXcReference(reference: string): KeePassXcEntry | undefined {
  if (reference.length > MAX_REFERENCE_LENGTH || !REFERENCE.test(reference)) return undefined;
  const [entry = "", attribute] = reference.slice(REFERENCE_PREFIX.length).split("#");
  return { entry, attribute: attribute ?? DEFAULT_ATTRIBUTE };
}

export const definition = defineSecretProvider({
  kind: SecretProviderKind.make("keepassxc"),
  label: "KeePassXC",
  configSchema: KeePassXcSecretProviderConfig,
  isReference: (reference) => parseKeePassXcReference(reference) !== undefined,
  referencePlaceholder: "keepassxc://group/entry",
  invalidReferenceMessage: "Use a KeePassXC reference like keepassxc://group/entry.",
});
