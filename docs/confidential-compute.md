# Confidential-compute investigation (separate from phase 1)

Status checked 2026-11-08: do not claim HarvestPool ballots or order aggregation are private.

## What current NEAR materials show

- NEAR's official docs describe off-chain compute as TEE-backed work that can return an attestation for code, inputs, and output. The docs list OutLayer, built by FastNEAR, as a third-party platform using Intel TDX enclaves with secrets, MPC vaults, VRF, persistent encrypted storage, and payment keys.
- The OutLayer documentation lists a private DAO-voting example where votes are tallied inside an enclave and only the result is published. It also explicitly says OutLayer is third-party and its operational guarantees, attestation verification flow, and key custody must be evaluated before production assets rely on it.
- NEAR AI Cloud documents confidential AI inference in TEEs with hardware attestation. It is an inference service, not evidence that HarvestPool can privately tally ballots or aggregate orders on-chain.
- NEAR Confidential Intents is aimed at confidential cross-chain execution/order flow. It is not a drop-in private ballot or produce-order contract primitive.

## Why it is not integrated here

The current contract must enforce public, inspectable financial rules on NEAR testnet. Integrating a private tally without verifying the exact input-authentication, attestation-verification, membership, replay, liveness, key custody, and failure semantics would replace a visible limitation with an unsupported privacy claim.

## Research gate for phase 2

Before integration, build a separate proof-of-concept that:

1. authenticates each eligible member into a private ballot without giving the Flask backend a signing or decryption key;
2. binds a ballot to a purchase ID, immutable terms hash, and one-member-one-vote nullifier;
3. verifies the TEE attestation or cryptographic proof in a NEAR contract or an independently auditable verifier;
4. publishes only the approved tally/result and proves that duplicate, omitted, replayed, or forged inputs are rejected;
5. specifies what happens if the enclave, verifier, service, or member key is unavailable;
6. never feeds a private tally into payment release until the evidence and trust model are documented and tested.

Until those checks pass, the web app should show public on-chain votes and quantities as public.
