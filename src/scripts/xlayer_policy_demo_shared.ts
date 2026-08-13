/**
 * Shared setup for the two X Layer policy demo scripts (AI Season build):
 * `demo_xlayer_policy_lifecycle.ts` (Definition-of-Done Scenario A/D — different subjects, same
 * task) and `demo_xlayer_task_risk_scenarios.ts` (Scenario B — same subject, different task
 * risk). Both need: a funded principal loaded from `PRIVATE_KEY`, and one or more ephemeral
 * subject keypairs funded with just enough testnet OKB to pay their own gas for
 * `validateAndRecordExecution` (the contract requires `msg.sender == policy.subject`, so each
 * subject must sign its own execution calls — this repo's other demo scripts only ever need one
 * signer, so this funding step is new).
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account } from "viem";
import { getPublicClient, getWalletClient } from "../lib/xlayer.js";

export function loadPrincipalAccount(): Account {
  const key = process.env.PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "[xlayer-policy-demo] PRIVATE_KEY not set — generate one with `cast wallet new`, fund it " +
        "from https://web3.okx.com/xlayer/faucet, then PRIVATE_KEY=0x... pnpm exec tsx ...",
    );
  }
  return privateKeyToAccount(key as `0x${string}`);
}

export function generateSubjectAccount(): Account {
  return privateKeyToAccount(generatePrivateKey());
}

/** Sends `amountWei` native OKB from `funder` to `to` and waits for the receipt — enough gas for
 *  a handful of `validateAndRecordExecution`/`issuePolicy` calls, not a real balance. */
export async function fundSubject(funder: Account, to: `0x${string}`, amountWei: bigint): Promise<void> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(funder);
  const hash = await walletClient.sendTransaction({ account: funder, to, value: amountWei });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  console.log(`[xlayer-policy-demo] funded ${to} with ${amountWei} wei OKB (tx=${hash})`);
}

export const DEMO_SUBJECT_GAS_WEI = 2_000_000_000_000_000n; // 0.002 OKB — gas only, not a real balance
