---
"@ag-bash/bash": patch
---

A redirection whose target cannot be opened or written is now reported as a shell error, like bash does, instead of making `exec()` reject with a raw filesystem error.

`x=1 > /nonexistent/f` (an assignment-only command or a bare redirect) used to reject with `ENOENT: no such file or directory, open '/nonexistent/f'`: the pre-truncation step used by those commands, and by subshells, `for`, `case`, `[[ ]]` and `(( ))`, never checked that the parent directory exists. They now report `bash: /nonexistent/f: No such file or directory` (or `Not a directory`, `Is a directory`, the `noclobber` message), exit with status 1 and carry on, and an assignment on the same line is still performed, as in bash. A refused redirect leaves its target alone: under `set -C` an existing file keeps its content, and a directory stays a directory. Found by the long fuzz run (`test:fuzz:long`, "combined malformed", seed 1736057820, run 7094).

Related cases fixed with it:

- `{fd}>file` created the file without any check. A missing parent made `exec()` reject, a directory was silently replaced by an empty regular file, and `noclobber` was ignored. It now fails with bash's message, leaves the variable as it was and keeps no descriptor; `{fd}>>file` is validated too.
- A write that fails after the up-front checks passed (permission denied on a host-backed `ReadWriteFs` directory, a symlink it refuses to follow, a descriptor opened with `exec 3> dir/f` whose directory has since been removed) is reported as `Permission denied` / `No such file or directory` / ... with exit status 1, for every redirect form, instead of rejecting. Whatever the command had already written to stderr is kept.
- With a `ReadWriteFs` the same redirect used to create the missing parent directories on the host; it no longer does.
- `break`, `continue`, `return` and `exit` with a redirection that cannot be opened (`exit 3 > /nonexistent/f` used to reject) now report the error, set `$?` to 1 and, as in bash, do not perform the jump. A redirection that does open leaves the jump alone: a `{fd}> file` is opened once (not a second time, which `set -C` refused) and `/dev/full` opens fine, since only writing to it fails.
- The up-front parent-directory check and the pre-truncation are skipped for the exact paths `/dev/null`, `/dev/stdout`, `/dev/stderr` and `/dev/full` (on the default in-memory filesystem they are still ordinary in-memory files that are opened and written, as before). `(echo hi) 2>/dev/null` and `exec {fd}>/dev/null` keep working on a `ReadWriteFs` whose root has no `/dev` directory.
- `noclobber` no longer refuses the device files `/dev/null`, `/dev/zero`, `/dev/full`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/random` and `/dev/urandom` (`set -C; exec {fd}> /dev/zero`). A regular file elsewhere under `/dev`, such as `/dev/shm/x`, keeps its protection.

What is still raised as an error from `exec()` rather than reported as a shell error:

- `EROFS`. A write to a read-only filesystem (for example `OverlayFs({ readOnly: true })`) rejects for every redirect form, as before; the CLI's read-only mode reports it from that raised error.
- Filesystem errors whose errno code is not one of `ENOENT`, `ENOTDIR`, `EISDIR`, `EACCES`, `EPERM`, `ENOSPC`, `EFBIG`, `ELOOP`, `ENAMETOOLONG`, `EEXIST`, `EBUSY`, `EMFILE` or `EIO` (for example `ENOTEMPTY`, `EXDEV`). The code is read from the error's `code` property, or from the `EXXX:` prefix of its message.
- Errors that carry no errno code, and execution-limit and security errors.

Not fixed here, left for follow-ups:

- The device skip above matches those four spellings exactly. `/dev//null`, `/dev/./null`, `//dev/null`, `/dev/zero`, `/dev/stdin`, `/dev/fd/N`, `/dev/tty` and `/dev/shm/x` can still report `No such file or directory` on a host-backed filesystem that has no `/dev` directory (in the forms that pre-truncate, develop only passed those by creating junk `dev/` files on the host). Classifying devices by resolved path would also change behaviour on the default filesystem (for example `echo hi > /dev//stdout`), so it needs its own change.
- `{fd}>>` and `{fd}&>>` targets are now validated like the other `{fd}` forms, so the same device spellings (for example `{fd}>> /dev/fd/1`) are checked too.
- `if`, `while` and `until` ignore their output redirections (as before).
- For a `{fd}>` that `noclobber` refuses, bash names the variable (`bash: fd: cannot overwrite existing file`); ag-bash names the path.
