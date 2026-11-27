import type { EnvironmentId, SecretProviderConfig, SecretProviderId } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { useState, type ReactNode } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  draftFromSecretProvider,
  emptySecretProviderDraft,
  secretProviderFromDraft,
  type SecretProviderDraft,
  type SecretProviderDraftIssues,
} from "./SecretProviderDialog.logic";

/** Mounted per open, so each open starts from a fresh draft. */
export function SecretProviderDialog({
  onClose,
  environmentId,
  environmentLabel,
  existingIds,
  existing,
}: {
  readonly onClose: () => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly existingIds: ReadonlySet<string>;
  readonly existing?: { readonly id: SecretProviderId; readonly config: SecretProviderConfig };
}) {
  const messages = useMessages();
  const gt = useGT();
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draft, setDraft] = useState<SecretProviderDraft>(
    existing ? draftFromSecretProvider(existing.config) : emptySecretProviderDraft("one_password"),
  );
  const [submitted, setSubmitted] = useState(false);
  const result = secretProviderFromDraft(
    draft,
    existingIds,
    existing ? { mode: "edit", id: existing.id } : { mode: "add" },
    messages,
  );
  const issues: SecretProviderDraftIssues =
    submitted && Result.isFailure(result) ? result.failure : {};
  const nameError = issues.name;

  const update = (patch: Partial<SecretProviderDraft>) => setDraft({ ...draft, ...patch });
  const save = () => {
    setSubmitted(true);
    if (Result.isFailure(result)) return;
    updateSettings({ secretProviders: { [result.success.id]: result.success.config } });
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? gt("Edit {label}", { label: existing.config.label })
              : draft.kind === "keepassxc"
                ? gt("Add a KeePassXC provider")
                : gt("Add a 1Password provider")}
          </DialogTitle>
          <DialogDescription>
            {draft.kind === "keepassxc" ? (
              <T>
                Provider variables on <Var>{environmentLabel}</Var> can read values from it by name.
                Values are read with keepassxc-cli on that server when a provider starts.
              </T>
            ) : (
              <T>
                Provider variables on <Var>{environmentLabel}</Var> can read values from it by name.
                Values are read with the op CLI on that server when a provider starts.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id="secret-provider-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {existing ? null : (
              <ToggleGroup
                aria-label={gt("Secret provider")}
                value={[draft.kind]}
                onValueChange={(values) => {
                  const kind = values[0];
                  if (kind === "one_password" || kind === "keepassxc") {
                    setSubmitted(false);
                    setDraft({ ...emptySecretProviderDraft(kind), name: draft.name });
                  }
                }}
              >
                <Toggle value="one_password">1Password</Toggle>
                <Toggle value="keepassxc">KeePassXC</Toggle>
              </ToggleGroup>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="secret-provider-name">
                <T>Name</T>
              </Label>
              <Input
                id="secret-provider-name"
                placeholder={gt("Personal")}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={64}
                aria-invalid={nameError !== undefined}
                aria-describedby={
                  nameError !== undefined ? "secret-provider-name-error" : undefined
                }
                autoFocus
              />
              {nameError !== undefined ? (
                <p
                  id="secret-provider-name-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {nameError}
                </p>
              ) : null}
            </div>
            {draft.kind === "keepassxc" ? (
              <>
                <PathField
                  id="secret-provider-database"
                  label={<T>Database</T>}
                  placeholder="/home/me/t3-secrets.kdbx"
                  value={draft.database}
                  error={issues.database}
                  onChange={(database) => update({ database })}
                />
                <PathField
                  id="secret-provider-key-file"
                  label={<T>Key file</T>}
                  placeholder="/home/me/.config/t3code-keepassxc/t3.keyx"
                  value={draft.keyFile}
                  error={issues.keyFile}
                  onChange={(keyFile) => update({ keyFile })}
                />
                <PathField
                  id="secret-provider-password-file"
                  label={<T>Password file</T>}
                  value={draft.passwordFile}
                  error={issues.passwordFile}
                  onChange={(passwordFile) => update({ passwordFile })}
                  hint={
                    <T>
                      Optional. A file holding the database password on one line, for a database
                      that has one. Keep it out of the folder the database syncs from.
                    </T>
                  }
                />
                <PathField
                  id="secret-provider-cli-path"
                  label={<T>CLI path</T>}
                  value={draft.cliPath}
                  error={issues.cliPath}
                  onChange={(cliPath) => update({ cliPath })}
                  hint={
                    <T>
                      Optional. Leave empty to use keepassxc-cli from PATH or the usual install
                      folder.
                    </T>
                  }
                />
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="secret-provider-account">
                  <T>Account</T>
                </Label>
                <Input
                  id="secret-provider-account"
                  placeholder="my.1password.com"
                  value={draft.account}
                  onChange={(event) => update({ account: event.target.value })}
                  maxLength={253}
                  spellCheck={false}
                  aria-invalid={issues.account !== undefined}
                  aria-describedby={
                    issues.account !== undefined ? "secret-provider-account-error" : undefined
                  }
                />
                <FieldError id="secret-provider-account-error" error={issues.account} />
                <p className="text-xs text-muted-foreground">
                  <T>
                    The account shorthand, sign-in address without https://, or ID that op account
                    list shows.
                  </T>
                </p>
              </div>
            )}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            <T>Cancel</T>
          </Button>
          <Button
            type="submit"
            form="secret-provider-form"
            disabled={submitted && Result.isFailure(result)}
          >
            {existing ? gt("Save changes") : gt("Add provider")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FieldError(props: { readonly id: string; readonly error: string | undefined }) {
  return props.error === undefined ? null : (
    <p id={props.id} role="alert" className="text-xs text-destructive">
      {props.error}
    </p>
  );
}

function PathField(props: {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly hint?: ReactNode;
}) {
  const errorId = `${props.id}-error`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        font="mono"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        maxLength={4096}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={props.error !== undefined}
        aria-describedby={props.error !== undefined ? errorId : undefined}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
      />
      <FieldError id={errorId} error={props.error} />
      {props.hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{props.hint}</p>
      )}
    </div>
  );
}
