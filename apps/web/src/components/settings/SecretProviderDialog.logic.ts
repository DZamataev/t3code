import {
  SecretProviderId,
  SecretProviderKind,
  SecretProviderLabel,
  type SecretProviderConfig,
} from "@t3tools/contracts";
import {
  KeePassXcPath,
  KeePassXcSecretProviderConfig,
} from "@t3tools/secret-provider-keepassxc/shared/definition";
import {
  OnePasswordSecretProviderConfig,
  type OnePasswordAccount,
} from "@t3tools/secret-provider-onepassword/shared/definition";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

const decodeSecretProviderId = Schema.decodeOption(SecretProviderId);
const decodeOnePasswordConfig = Schema.decodeUnknownOption(OnePasswordSecretProviderConfig);
const decodeKeePassXcConfig = Schema.decodeUnknownOption(KeePassXcSecretProviderConfig);

export type SecretProviderDraftKind = "one_password" | "keepassxc";

export type ClassifiedSecretProvider =
  | { readonly kind: "one_password"; readonly account: OnePasswordAccount }
  | { readonly kind: "keepassxc"; readonly config: KeePassXcSecretProviderConfig }
  | { readonly kind: "unsupported" };

/** Unknown kinds and configs that no longer decode are shown read-only; removal stays available. */
export function classifySecretProvider(provider: SecretProviderConfig): ClassifiedSecretProvider {
  if (provider.kind === "one_password") {
    const decoded = decodeOnePasswordConfig(provider.config);
    return decoded._tag === "Some"
      ? { kind: "one_password", account: decoded.value.account }
      : { kind: "unsupported" };
  }
  if (provider.kind === "keepassxc") {
    const decoded = decodeKeePassXcConfig(provider.config);
    return decoded._tag === "Some"
      ? { kind: "keepassxc", config: decoded.value }
      : { kind: "unsupported" };
  }
  return { kind: "unsupported" };
}

/** Stable and readable in settings.json, so re-adding a provider under the same name restores its variables. */
function secretProviderIdFromName(name: string): SecretProviderId | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64)
    .replace(/-$/, "");
  return Option.getOrNull(decodeSecretProviderId(slug));
}

export interface SecretProviderDraft {
  readonly kind: SecretProviderDraftKind;
  readonly name: string;
  readonly account: string;
  readonly database: string;
  readonly keyFile: string;
  readonly passwordFile: string;
  readonly cliPath: string;
}

export const emptySecretProviderDraft = (kind: SecretProviderDraftKind): SecretProviderDraft => ({
  kind,
  name: "",
  account: "",
  database: "",
  keyFile: "",
  passwordFile: "",
  cliPath: "",
});

export function draftFromSecretProvider(provider: SecretProviderConfig): SecretProviderDraft {
  const classified = classifySecretProvider(provider);
  if (classified.kind === "keepassxc") {
    const { config } = classified;
    return {
      ...emptySecretProviderDraft("keepassxc"),
      name: provider.label,
      database: config.database,
      keyFile: config.keyFile,
      passwordFile: config.passwordFile ?? "",
      cliPath: config.cliPath ?? "",
    };
  }
  return {
    ...emptySecretProviderDraft("one_password"),
    name: provider.label,
    account: classified.kind === "one_password" ? classified.account : "",
  };
}

export type SecretProviderTarget =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly id: SecretProviderId };

export type SecretProviderDraftIssues = {
  readonly [Field in Exclude<keyof SecretProviderDraft, "kind">]?: string;
};

function decodeField<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: string,
  emptyMessage: string,
): Result.Result<S["Type"], string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Result.fail(emptyMessage);
  return Result.mapError(Schema.decodeResult(schema)(trimmed), (error) => error.message);
}

/** The settings entry a draft adds or replaces, or every field that blocks it, one message each. */
export function secretProviderFromDraft(
  draft: SecretProviderDraft,
  existingIds: ReadonlySet<string>,
  target: SecretProviderTarget,
  resolve: MessageResolver = m,
): Result.Result<
  { readonly id: SecretProviderId; readonly config: SecretProviderConfig },
  SecretProviderDraftIssues
> {
  const label = decodeField(SecretProviderLabel, draft.name, resolve(msg("Enter a name.")));

  let id: SecretProviderId | null = null;
  let nameIssue: string | undefined;
  if (Result.isFailure(label)) {
    nameIssue = label.failure;
  } else {
    id = target.mode === "edit" ? target.id : secretProviderIdFromName(label.success);
    if (id === null) nameIssue = resolve(msg("The name needs at least one letter or digit."));
    else if (target.mode === "add" && existingIds.has(id))
      nameIssue = resolve(msg("A secret provider with this name exists."));
  }

  const config: Result.Result<SecretProviderConfig["config"], SecretProviderDraftIssues> =
    draft.kind === "keepassxc"
      ? keePassXcConfig(draft, resolve)
      : onePasswordConfig(draft, resolve);
  if (
    id === null ||
    nameIssue !== undefined ||
    Result.isFailure(label) ||
    Result.isFailure(config)
  ) {
    return Result.fail({
      ...(nameIssue === undefined ? {} : { name: nameIssue }),
      ...(Result.isFailure(config) ? config.failure : {}),
    });
  }
  return Result.succeed({
    id,
    config: {
      kind: SecretProviderKind.make(draft.kind),
      label: label.success,
      config: config.success,
    },
  });
}

function onePasswordConfig(
  draft: SecretProviderDraft,
  resolve: MessageResolver,
): Result.Result<OnePasswordSecretProviderConfig, SecretProviderDraftIssues> {
  const account = decodeField(
    OnePasswordSecretProviderConfig.fields.account,
    draft.account,
    resolve(msg("Enter the 1Password account.")),
  );
  return Result.isFailure(account)
    ? Result.fail({ account: account.failure })
    : Result.succeed({ account: account.success });
}

const decodePath = Schema.decodeOption(KeePassXcPath);

function keePassXcConfig(
  draft: SecretProviderDraft,
  resolve: MessageResolver,
): Result.Result<KeePassXcSecretProviderConfig, SecretProviderDraftIssues> {
  const notAbsolute = resolve(msg("Enter an absolute path on the server."));
  const paths = {
    database: draft.database.trim(),
    keyFile: draft.keyFile.trim(),
    passwordFile: draft.passwordFile.trim(),
    cliPath: draft.cliPath.trim(),
  };
  const issues: { -readonly [Field in keyof typeof paths]?: string } = {};
  const decoded: { -readonly [Field in keyof typeof paths]?: KeePassXcPath } = {};
  for (const field of Object.keys(paths) as Array<keyof typeof paths>) {
    if (paths[field].length === 0) continue;
    const path = decodePath(paths[field]);
    if (Option.isSome(path)) decoded[field] = path.value;
    else issues[field] = notAbsolute;
  }
  if (paths.database.length === 0) issues.database = resolve(msg("Enter the database path."));
  if (paths.keyFile.length === 0) issues.keyFile = resolve(msg("Enter the key file path."));
  if (
    Object.keys(issues).length > 0 ||
    decoded.database === undefined ||
    decoded.keyFile === undefined
  ) {
    return Result.fail(issues);
  }
  return Result.succeed({
    database: decoded.database,
    keyFile: decoded.keyFile,
    ...(decoded.passwordFile === undefined ? {} : { passwordFile: decoded.passwordFile }),
    ...(decoded.cliPath === undefined ? {} : { cliPath: decoded.cliPath }),
  });
}
