# Publication checks — November 24, 2026

- Clean install: `npm ci --ignore-scripts` completed.
- Build: `npm run build` passed.
- Secrets: Gitleaks scan of the new Git history passed. One narrowly scoped rule recognizes the 360dialog configuration-property reference as code, not a literal secret.
- Included tests: **77 passed, 6 failed** across seven files.
- Passing suites: 360dialog provider, restaurant information, scheduled orders, bank-mail parsing/checks, and bank-mail OAuth routes.

## Outstanding test failures

The following existing allowlist/prelaunch expectations do not pass against this source snapshot; publication does not claim they have been resolved:

1. Approved-number cash-on-delivery walkthrough: expected a confirmed order, received none.
2. Allowlisted reminders: expected two sends, received zero.
3. Disposable rehearsal walkthrough: expected a confirmed order, received none.
4. Prelaunch cooldown: expected a second message, received one.
5. Prelaunch menu visibility: expected HTTP 404, received 200.
6. Standby webhook verification: expected HTTP 200, received 503.

The dependency install also reported 14 audit findings (2 moderate, 9 high, 3 critical). Dependencies were preserved from the working application; dependency upgrades and a full production security review are outside this publication change.

## Publication-only adaptations

- New Git history without internal operational documents or exports.
- Personal bank mailbox replaced with the required `BANK_MAIL_EMAIL` setting.
- Real payment identifiers replaced with dummy zeros; real payment QR omitted.
- Tests use a fictional mailbox and matching dummy payment identifiers.
- Scheduled-order tests load local source instead of an internal release directory.
- Internal deployment/rehearsal scripts and private catalog snapshots omitted; package scripts expose the included development/build/database commands.

No production service was changed by publishing this repository.
