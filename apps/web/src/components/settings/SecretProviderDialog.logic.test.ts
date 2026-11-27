import { SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  draftFromSecretProvider,
  emptySecretProviderDraft,
  secretProviderFromDraft,
} from "./SecretProviderDialog.logic";

const onePassword = (name: string, account: string) => ({
  ...emptySecretProviderDraft("one_password"),
  name,
  account,
});
const keePassXc = (fields: Partial<ReturnType<typeof emptySecretProviderDraft>>) => ({
  ...emptySecretProviderDraft("keepassxc"),
  name: "Deck vault",
  ...fields,
});

describe("secretProviderFromDraft", () => {
  it("adds a provider keyed by its name and reports every field that blocks it", () => {
    expect(
      secretProviderFromDraft(onePassword("  1Password!  ", "my.1password.com"), new Set(), {
        mode: "add",
      }),
    ).toEqual(
      Result.succeed({
        id: "1password",
        config: {
          kind: "one_password",
          label: "1Password!",
          config: { account: "my.1password.com" },
        },
      }),
    );

    const blocked = secretProviderFromDraft(
      onePassword("1Password", "--help"),
      new Set(["1password"]),
      { mode: "add" },
    );
    expect(Result.isFailure(blocked) && Object.keys(blocked.failure).toSorted()).toEqual([
      "account",
      "name",
    ]);
  });

  it("keeps the id when an edit renames the provider", () => {
    const id = SecretProviderId.make("personal");
    const result = secretProviderFromDraft(
      onePassword("Personal (team)", "team.1password.com"),
      new Set(["personal"]),
      { mode: "edit", id },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id,
      config: {
        kind: "one_password",
        label: "Personal (team)",
        config: { account: "team.1password.com" },
      },
    });
  });

  it("adds a KeePassXC database with only the paths that are set", () => {
    const result = secretProviderFromDraft(
      keePassXc({ database: " /home/deck/t3.kdbx ", keyFile: "/home/deck/t3.keyx" }),
      new Set(),
      { mode: "add" },
    );
    expect(Result.isSuccess(result) && result.success).toEqual({
      id: "deck-vault",
      config: {
        kind: "keepassxc",
        label: "Deck vault",
        config: { database: "/home/deck/t3.kdbx", keyFile: "/home/deck/t3.keyx" },
      },
    });
    expect(Result.isSuccess(result) && draftFromSecretProvider(result.success.config)).toEqual(
      keePassXc({ database: "/home/deck/t3.kdbx", keyFile: "/home/deck/t3.keyx" }),
    );
  });

  it("asks for a database, an unlock file, and absolute paths", () => {
    const blocked = secretProviderFromDraft(keePassXc({ cliPath: "keepassxc-cli" }), new Set(), {
      mode: "add",
    });
    expect(Result.isFailure(blocked) && blocked.failure).toEqual({
      database: "Enter the database path.",
      keyFile: "Set a key file, a password file, or both.",
      cliPath: "Enter an absolute path on the server.",
    });
  });
});
