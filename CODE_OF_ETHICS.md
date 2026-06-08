# TechMages Code of Ethics

Every serious security tool is dual-use. `nmap` maps your network or someone
else's. Kali is a defender's lab or an attacker's kit depending on the hand on
the keyboard. The capability is the capability — what separates a profession
from a crime is the posture of the person at the keyboard.

TechMages builds for that profession: MSPs, security professionals on
authorized engagements, and serious students of the craft. Contributing here —
**by opening a pull request, filing an issue, or shipping a build** — means
committing to that posture. You affirm the following.

## The pledge

1. **Authorization before action.** I use these tools only against systems I own
   or am explicitly authorized — in writing — to test.

2. **Honest scope.** I keep my engagement scope truthful and narrow. I do not
   expand it to reach targets I was not authorized to touch.

3. **Accountability over deniability.** I keep records. I will not strip,
   disable, or circumvent the audit trail, the engagement gate, or the kill
   switch — not in my own use, and not in code I contribute.

4. **Capability, not weaponry.** I will not contribute features whose primary
   purpose is to evade detection, attack non-consenting third parties, or cause
   indiscriminate harm.

5. **Responsible disclosure.** When I find a vulnerability — in these tools or in
   a system I'm authorized to test — I disclose it responsibly and give the owner
   reasonable time to fix it before going public.

6. **Respect for privacy.** Captured data — handshakes, traffic, locations,
   signals — is sensitive. I minimize what I collect and never retain or publish
   other people's data without cause and consent.

7. **Teach, don't enable.** I share knowledge to make defenders better, not to
   lower the bar for people who intend harm.

8. **Own the outcome.** If I wouldn't want the signed audit trail of what I did
   read back to me in a room with the client and their lawyer, I don't do it.

## The line

Use these tools on systems you own or are authorized to test. Keep your scope
honest. Keep your records. The white-hat posture isn't a costume here — in
Warlock OS it is engineered into the build: an engagement gate that keeps
offense inert until a scoped engagement is armed, run-time scope enforcement, a
kill switch that reaches every queue, and signed Agent Attestation Records
(Ed25519 / JCS / `did:web`) so a third party can verify exactly what a device
did, offline, without having to trust us.

This is part of the social contract of the project, alongside the
[Charter](https://techmages.org/charter.html) and
[CONTRIBUTING.md](./CONTRIBUTING.md). Violating it is grounds for having
contributions rejected and access revoked.

*Build wisely.*
