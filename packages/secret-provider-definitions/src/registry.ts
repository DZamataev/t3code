import { makeSecretProviderDefinitionRegistry } from "@t3tools/secret-provider-core/shared/definition";
import * as KeePassXc from "@t3tools/secret-provider-keepassxc/shared/definition";
import * as OnePassword from "@t3tools/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
  KeePassXc.definition,
]);
