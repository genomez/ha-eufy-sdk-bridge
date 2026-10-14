> Modified for genomez S1 experimental source preview, 2026-10-14.

# Contributing to the experimental source preview

Read [EXPERIMENTAL.md](EXPERIMENTAL.md) before working on this branch. Target pull requests at `s1-experimental`, not `main`. Keep changes narrow and explain how a synthetic test verifies the behavior.

This source reference does not include a supported runtime installation. In particular, the inherited SDK registry pin does not select the customized SDK used in private qualification. Do not run the bridge against an account while assuming an ordinary dependency install recreated that pair. A public paired build is separate release work.

Do not commit runtime options, credentials, session files, captures, raw logs, real camera images or device/network/account identifiers. Supply synthetic fixtures and redacted descriptions. Preserve notices and attribution. No image publishing or upstream-message action is part of this contribution workflow.
