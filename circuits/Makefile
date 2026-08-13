# KARMA ZK circuits — Stellar ZK track (T4 + T1.1)
#
# `make toolchain` installs circom + snarkjs locally (idempotent).
# `make dummy` runs the toolchain-validation pipeline (multiplier circuit).
# `make credential` runs the AgentCredentialProof end-to-end pipeline (T4).
# `make repagg` runs the ReputationAggregationProof end-to-end pipeline (T1.1).
# `make policy-credential` runs the PolicyCredentialProof end-to-end pipeline (AI Season).
# `make all` runs every pipeline.

SHELL := /usr/bin/env bash

.PHONY: all toolchain dummy credential repagg policy-credential clean

all: toolchain dummy credential repagg policy-credential

toolchain:
	@bash scripts/install-toolchain.sh

dummy: toolchain
	@node test/dummy_multiplier.test.mjs

credential: toolchain
	@node test/agent_credential.test.mjs

repagg: toolchain
	@node test/reputation_aggregation.test.mjs

policy-credential: toolchain
	@node test/policy_credential.test.mjs

clean:
	@rm -rf build/
