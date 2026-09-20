# Chromium namespace sandbox profile

`seccomp-chromium.json` derives from the [Moby default seccomp profile](https://github.com/moby/profiles/blob/245180c51918481c0525424b3ee025d2b435d46c/seccomp/default.json), pinned at commit `245180c51918481c0525424b3ee025d2b435d46c`. The upstream file SHA-256 is `785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`. Moby licenses it under Apache-2.0; the accompanying unmodified license is [seccomp-chromium.LICENSE](seccomp-chromium.LICENSE).

Blind appends three rules; all upstream rules and the default deny action remain:

- `clone`: on amd64/arm64, permit user, PID and network namespace flags. The mask `0x0e020000` must remain zero, preserving the block on new mount, cgroup, UTS and IPC namespaces. Ordinary clone flags retain the upstream behavior.
- `unshare`: permit exactly `CLONE_NEWUSER` (`0x10000000`).
- `chroot`: permit Chromium's filesystem sandbox setup after entering its own user namespace. The kernel still requires the caller to have the appropriate capability in that namespace. The container receives no additional capabilities.

`clone3` retains upstream's `ENOSYS` result without `CAP_SYS_ADMIN`, allowing libc to fall back to argument-filterable `clone`. `setns` remains denied without that capability. The additions follow Chromium's [namespace creation](https://github.com/chromium/chromium/blob/994830625f96f65499ab2e060e6dcd2707bf9f49/sandbox/linux/services/namespace_sandbox.cc) and [credential/filesystem sandbox](https://github.com/chromium/chromium/blob/994830625f96f65499ab2e060e6dcd2707bf9f49/sandbox/linux/services/credentials.cc) code. They are narrower than Playwright's [documented blanket allowance for clone/setns/unshare](https://playwright.dev/docs/docker#crawling-and-scraping).

Compose uses `seccomp:./seccomp-chromium.json` alongside the existing non-root user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem and memory/CPU limits. Keep those protections enabled. The host kernel must permit unprivileged user namespaces; a profile cannot override a host policy that disables them. Only Linux amd64 is currently covered by the release container test; the arm64 clone argument layout is included for source-built images.

After upgrading Chromium or this pinned default, run `tests/integration_container.py` against the freshly built runtime image. For a direct sandbox diagnostic, run Chromium with the same container protections and `--headless=new --allow-chrome-scheme-url --dump-dom chrome://sandbox`; require Namespace, PID/network namespaces and Seccomp-BPF/TSYNC to be enabled. The extra Chrome-scheme flag is only for this diagnostic, never for Blind's export process.

