# Contributing to TechMages / Warlock OS

Thanks for helping build open, white-hat, authorization-first security tools.
These tools get better when defenders build them together.

> **Read this first:** [CODE_OF_ETHICS.md](./CODE_OF_ETHICS.md). Opening a pull
> request affirms it. Everything below assumes you have.

## Ways to contribute

You don't have to write a line of code to make this project stronger.

| Lane | What it looks like |
|---|---|
| **Code** | New modules, bug fixes, hardening the engagement gate, tests. Python (FastAPI) backend, Ink/React TUI, React/Vite web UI. |
| **Documentation** | Setup guides, the build-your-own BOM, module how-tos, fixing anything wrong or unclear. |
| **Hardware** | Build the deck from the BOM, report what worked and what didn't, test new SDR / GPS / mesh peripherals. |
| **Field reports** | You ran it on a real authorized engagement — tell us what held up and what was missing. |
| **Triage** | Reproduce issues, confirm bugs, review pull requests, help newcomers get a deck booting. |
| **Disclosure** | Found a flaw in the tooling itself? Report it privately — see [Security](#reporting-a-security-issue). |

## How to submit a change

1. **Fork** the repository and create a branch: `feat/<thing>` or `fix/<thing>`.
2. **Keep changes additive and backward-compatible** where you can. The
   engagement gate, scope enforcement, kill switch, and audit / attestation
   paths are load-bearing — **do not route around them.**
3. **Add tests** for new behavior and run the existing suite before you push.
4. **Write a clear PR description** — what changed, why, and how you verified it.
   Opening the PR affirms the [Code of Ethics](./CODE_OF_ETHICS.md).
5. Keep commits focused; prefer a clean, readable history.

### Code style

- Match the surrounding code — naming, structure, comment density, idiom.
- Backend modules follow the existing **registry pattern**; new capabilities
  register through it rather than bolting onto the app directly.
- API changes should be **additive and backward-compatible** so existing TUI and
  web clients keep working.

## What we won't merge

- Anything whose only purpose is to defeat the engagement gate, the scope check,
  the kill switch, or the audit / attestation trail.
- Stealth / anti-forensics features dressed up as "operational security" but
  really built to hide unauthorized activity.
- Targeting, mass-exploitation, or credential-harvesting tooling aimed at
  non-consenting third parties.
- Anything that ships secrets, real client data, or another person's captured
  traffic in the diff.

## Reporting a security issue

Found a way to bypass the gate, forge an attestation, or escalate beyond an
authorized scope? **Do not open a public issue.** Open a private
[GitHub security advisory](https://github.com/techmages-org/warlock/security/advisories/new)
instead. We'll work the fix with you and credit you when it ships.

## License

Documentation is open (MIT); names and marks are reserved. By contributing, you
agree your contributions are licensed under the repository's terms.

---

See also: [Charter](https://techmages.org/charter.html) ·
[Contribute](https://techmages.org/contribute.html) ·
[Code of Ethics](./CODE_OF_ETHICS.md)

*Build wisely.*
