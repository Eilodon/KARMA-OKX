# KARMA — X Layer AI Season Hackathon Demo Script (AI-RWA track, X post tagging @XLayerOfficial)

**This is a different hackathon from the OKX.AI Genesis one** (`docs/demo-video-script-okx.md`,
deadline already passed 27 July) — different story, different deadline (21 Aug 2026, 23:59 UTC),
different track. Do not reuse the old script; it never mentions the policy compiler at all.

**Target length: ~90–120 seconds.** The official AI Season page does not state an explicit video
length limit the way Genesis's ASP tutorial did — check `web3.okx.com/xlayer/build-x-series`
yourself before recording in case that's changed. 90–120s fits comfortably inside X's native video
limit for a standard (non-Premium) account (140s) either way.

**Format:** live terminal capture (real output, real addresses) + voiceover + burned-in captions.
**Golden rule (same as every KARMA demo):** everything on screen is real and reproducible. No
mocked output, no faked success.

---

## One-line pitch (cold open + X post caption)

> **KARMA prevents AI agents from making unsafe economic decisions — it compiles an agent's
> reputation and a task's risk into an enforceable spending policy, and X Layer refuses any
> transaction that breaks it.**

X post caption (under 280 chars, include the demo link + tag):
> Built an Economic Policy Layer for AI agents on @XLayerOfficial: before an agent pays another
> agent, KARMA compiles a hard spending cap, bond, and evaluator requirement — and the contract
> reverts if it's broken. Real tx, real revert. #AISeason [demo video] [github link]

---

## Scene-by-scene (target cuts, ~100s total)

### COLD OPEN — the gap (0:00–0:12)

- **ON SCREEN:** black → one line of text.
- **VOICEOVER:** "An AI agent is about to pay another agent for a task. It has a private key and
  no supervisor. What stops it from sending everything it has?"
- **CAPTION:** `Autonomous agents can spend. Nothing tells them how much they're allowed to.`

---

### SCENE 1 — the compiler, live (0:12–0:35)

- **ON SCREEN:** the interactive demo page (`docs/media/xlayer_policy_demo.html`, live at
  `https://eilodon.github.io/KARMA-OKX/xlayer_policy_demo.html`). Fill in a low-risk task preset,
  compile → show `policyHash` and the terms (cap, bond, evaluator) appear. Switch to the high-risk
  preset, recompile — terms visibly tighten on screen.
- **VOICEOVER:** "This is KARMA's policy compiler — running right now, in a browser, no wallet.
  Same agent, same track record. Low-risk task: a 100 USDT cap, no evaluator needed. Same agent,
  higher-risk task — custody involved — and the cap is cut in half, a bond is required, a panel
  has to sign off. This isn't a wallet score. It's underwriting the job."
- **CAPTION:** `Same agent. Different task. Different terms. Live in your browser.`
- **WOW BEAT:** the terms-diff table updating in real time.

---

### SCENE 2 — the chain says no (0:35–1:00)

- **ON SCREEN:** terminal capture of Scenario A against the live contract (see Appendix A for the
  exact commands / tx hashes to have ready as cutaways).
- **VOICEOVER:** "And this isn't just advice in a dashboard — it's enforced on-chain. Here's an
  agent with a thin track record, compiled to a 50-USDT cap. It tries to spend 25. Watch."
  *(cut to the revert)* "Rejected. On X Layer testnet, for real — not a mock, not a require()
  statement that never runs in a demo."
- **CAPTION:** `validateAndRecordExecution reverts on-chain. PER_TRANSACTION_LIMIT_EXCEEDED.`
- **WOW BEAT:** the reverted transaction on the X Layer explorer (OKLink), hold 1.5s.

---

### CLOSE (1:00–1:20)

- **ON SCREEN:** one-line pitch + GitHub URL + `#AISeason` + tag `@XLayerOfficial`.
- **VOICEOVER:** "KARMA: the economic policy layer for autonomous agents. Reputation tells an
  agent who to trust. KARMA decides what they're allowed to do — and X Layer enforces it."
- **CAPTION:** `github.com/Eilodon/KARMA-OKX · #AISeason · @XLayerOfficial`

---

## Appendix A — Capture commands / cutaways (exact, reproducible)

**Interactive compiler (Scene 1) — the only step that needs zero setup for you or the judge:**
```
https://eilodon.github.io/KARMA-OKX/xlayer_policy_demo.html
```

**Scenario A re-run against the live contract (Scene 2), or use the already-recorded proof below
instead of re-running live on camera:**
```bash
XLAYER_POLICY_ENFORCER_ADDRESS=0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075 PRIVATE_KEY=0x... \
  pnpm demo:xlayer:policy-lifecycle
```

**Already-recorded real transactions (safe to screen-record the explorer page directly, no key
needed, nothing to re-run):**
- Alpha PERMITTED (80 USDT, within 100/500 cap):
  `https://www.oklink.com/xlayer-test/tx/0x92395d48333f9914a617161f6b450c63c5f8eacf8c46c514206496858862a0bc`
- Beta REJECTED — `PER_TRANSACTION_LIMIT_EXCEEDED` (25 USDT against a 10/50 cap):
  `https://www.oklink.com/xlayer-test/tx/0xd43b1b5ca0a351c02a9f766f1ad5389d106353f5ef47be9f54cbb26f3fc05beb`
- Contract itself: `https://www.oklink.com/xlayer-test/address/0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075`

**Full judge walkthrough page (good to show as a cutaway or link in the post):**
```
https://eilodon.github.io/KARMA-OKX/xlayer-policy-judges.html
```

---

## Appendix B — Honesty guardrails (read before recording)

1. Keep real addresses/tx hashes on screen (testnet only, no real-value secrets exposed) —
   authenticity is the point, same as every KARMA demo before this one.
2. If re-running the demo scripts live on camera, use a fresh testnet key with no real value —
   never expose `KEYSTORE_PASSWORD` or `PRIVATE_KEY` on screen.
3. Numbers to state, all current and verifiable at time of writing: **63 passing tests** across
   the compiler kernel (36), the contract (20, including a 256-run fuzz test and 6 EIP-712
   signature tests), and the MCP tools (7) — see `docs/AI_SEASON_HACKATHON_CHECKLIST.md`.
4. Don't lead with the 4-chain reputation oracle or the ZK circuit in this video — they're real and
   tested, but they dilute the one-sentence pitch. Keep them as answers if asked, not part of the
   ~100s cut.
