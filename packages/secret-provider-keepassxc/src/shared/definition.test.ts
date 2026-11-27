import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  definition,
  KeePassXcSecretProviderConfig,
  parseKeePassXcReference,
} from "./definition.ts";

describe("KeePassXC definition", () => {
  it("reads the password unless the reference names an attribute", () => {
    expect(parseKeePassXcReference("keepassxc://Codex/codex-lb oneclick")).toEqual({
      entry: "Codex/codex-lb oneclick",
      attribute: "password",
    });
    expect(parseKeePassXcReference("keepassxc://Anthropic#UserName")).toEqual({
      entry: "Anthropic",
      attribute: "UserName",
    });
    expect(parseKeePassXcReference("keepassxc://Серверы/дека#api key")).toEqual({
      entry: "Серверы/дека",
      attribute: "api key",
    });
  });

  it("rejects anything that is not a plain reference", () => {
    for (const reference of [
      "--help",
      "Codex/entry",
      "op://Private/OpenAI/credential",
      "keepassxc://",
      "keepassxc:///Codex",
      "keepassxc://Codex//entry",
      "keepassxc://Codex/entry/",
      "keepassxc://-entry",
      "keepassxc://Codex/entry#-a",
      "keepassxc://Codex/entry#",
      "keepassxc://Codex/entry#a#b",
      "keepassxc://Codex/ entry",
      "keepassxc://Codex\n/entry",
      `keepassxc://Codex/${"x".repeat(1024)}`,
    ]) {
      expect(definition.isReference(reference), reference).toBe(false);
    }
  });

  it("needs absolute paths and a key file", () => {
    const isConfig = Schema.is(KeePassXcSecretProviderConfig);
    expect(isConfig({ database: "/home/deck/t3.kdbx", keyFile: "/home/deck/t3.keyx" })).toBe(true);
    expect(
      isConfig({
        database: "C:\\Users\\me\\t3.kdbx",
        keyFile: "C:/Users/me/t3.keyx",
        passwordFile: "C:/Users/me/t3.pw",
      }),
    ).toBe(true);
    expect(isConfig({ database: "\\\\nas\\vault\\t3.kdbx", keyFile: "/k" })).toBe(true);
    expect(isConfig({ database: "/home/deck/t3.kdbx" })).toBe(false);
    expect(isConfig({ database: "/home/deck/t3.kdbx", passwordFile: "/t3.pw" })).toBe(false);
    expect(isConfig({ database: "t3.kdbx", keyFile: "/k" })).toBe(false);
    expect(isConfig({ database: "~/t3.kdbx", keyFile: "/k" })).toBe(false);
    expect(isConfig({ database: "/t3.kdbx", keyFile: "-k" })).toBe(false);
    expect(isConfig({ database: "/t3\n.kdbx", keyFile: "/k" })).toBe(false);
  });
});
