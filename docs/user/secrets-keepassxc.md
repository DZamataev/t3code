# KeePassXC

T3 Code can read provider keys and other credentials from a [KeePassXC](https://keepassxc.org/)
database. The T3 Code server reads the entry with `keepassxc-cli` when it needs the value, so the
value stays in the database and T3 Code saves only a reference to the entry.

For the basics, see [Secrets](./secrets.md).

## Before you start

T3 Code runs `keepassxc-cli` on the machine that runs the T3 Code server, often with nobody there to
type a master password. So it opens the database with a key file, and optionally with a password
read from a file:

| Database is protected by | Set in T3 Code             |
| ------------------------ | -------------------------- |
| Key file only            | Key file                   |
| Password and key file    | Key file and password file |
| Password only            | Password file              |

Use a separate database that holds only what the server needs, not your personal vault. Every key in
it can be read by anything that runs as the server's user, agents included.

Keep the key file and the password file out of any folder that syncs or backs up the database. On
Linux and macOS, make them readable only by you (`chmod 600`).

## Set it up

1. Install KeePassXC 2.7 or later on the machine that runs the T3 Code server.
2. Create a database for the server. With a key file only:

   ```bash
   keepassxc-cli db-create --set-key-file ~/.config/t3code-keepassxc/t3.keyx ~/t3-secrets.kdbx
   ```

   KeePassXC asks for an optional password. Press Enter twice to use the key file alone.

3. Add entries in KeePassXC, or with `keepassxc-cli add`. Put the key in the entry's password.
4. In **Settings → Secrets**, select **Add provider**, then **KeePassXC**. Enter a name, the
   database path, and the key file path, the password file path, or both. Paths must be absolute.
5. Pick the provider as the source of a field and enter a reference to the entry.

T3 Code looks for `keepassxc-cli` on `PATH`, then in the usual install folders:
`/Applications/KeePassXC.app` on macOS and `C:\Program Files\KeePassXC` on Windows. If it lives
elsewhere, for example a Flatpak or AppImage install on Linux, set **CLI path** to the executable or
a wrapper script.

## References

A reference is `keepassxc://` followed by the entry's path as `keepassxc-cli ls -R` shows it, groups
separated by `/`. The value is the entry's password unless you name an attribute after `#`:

| Reference                             | Reads                                            |
| ------------------------------------- | ------------------------------------------------ |
| `keepassxc://Codex/codex-lb oneclick` | Password of `codex-lb oneclick` in group `Codex` |
| `keepassxc://Anthropic#UserName`      | User name of `Anthropic`                         |
| `keepassxc://Servers/deck#api-key`    | Custom attribute `api-key`                       |

Spaces are fine. A name that contains `#`, `/`, or a line break cannot be written as a reference;
rename the entry or group. Names cannot start with `-`.

## Check that it works

On the server's machine, read the entry the way T3 Code does. With a key file only:

```bash
keepassxc-cli show -q -s -a password --no-password -k ~/.config/t3code-keepassxc/t3.keyx \
  ~/t3-secrets.kdbx "Codex/codex-lb oneclick" >/dev/null && echo "Secret read"
```

With a password file, add the password on standard input instead of `--no-password`:
`... < /path/to/password-file`.

Then select the check button next to the reference in Settings to read it on the server.

## Unattended servers

What T3 Code can open by itself, anything else running as the same user can open too. A key file or
password file protects the database when it is copied, synced, or backed up without that file, and
keeps keys out of T3 Code's own settings and data folder. It does not protect against someone who
can run programs as the server's user.

To also protect the file at rest, let the operating system hold it:

- **Linux with systemd.** Encrypt the key file or password with `systemd-creds encrypt` (bound to the
  TPM or the host key), add `LoadCredentialEncrypted=` to the T3 Code service, and point T3 Code at
  the decrypted copy under `/run/user/<uid>/credentials/<service>/`. It exists only while the service
  runs.
- **Windows.** Store the file in a folder only your account can read, and encrypt it with EFS
  (**Properties → Advanced → Encrypt contents**).
- **macOS.** Turn on FileVault.

## When a secret cannot be read

The field that needs the secret shows an error naming the provider when `keepassxc-cli` is missing,
the key file or password is wrong, the password file is missing, or the entry or attribute does not
exist. T3 Code logs which of these it was, never the value.

T3 Code keeps each value it reads until you select **Refresh** in **Settings → Providers** or check
the reference again, so changing an entry does not take effect until then. Each read opens the
database once per reference and waits up to 30 seconds in total.
