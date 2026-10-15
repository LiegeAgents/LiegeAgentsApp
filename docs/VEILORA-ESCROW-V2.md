# Veilora job escrow V2 handoff

**Status:** Veilora deployed and verified the V2 factory on Robinhood Chain (chain ID 4663) on 2026-10-15. Liege still needs to wire its backend and configure the V2 factory address before V2 jobs are production-ready.

Deployment details:

- Factory: `0x81E05B0Ee0229ac62ED4e3bc9242aa0b9Ac0830E`
- Transaction: `0xd0c3ebda36105dd31df57211561721db18f65fcdeda9c3790b54b1d8a7703b17`
- Deployer: `0x695d8E941e68D3ea39c14C43745286b5729E8CD7`
- Runtime code hash: `0x1002c95f42753fdffc2c1e4e4b33e5df5a604efe26adb73190e3124ad35ae589`
- Explorer: https://robinhoodchain.blockscout.com/address/0x81E05B0Ee0229ac62ED4e3bc9242aa0b9Ac0830E

## Why V2 is needed

The deployed V1 escrow accepts any two outcome approvals from the client, evaluator, and Liege signer. After a provider has submitted work, the client and Liege signer can therefore approve a refund without the evaluator. The provider’s signature records acceptance and a deliverable commitment, but does not authorize settlement.

Liege’s current settlement path already collects the evaluator’s signature and Liege’s signature for outcomes. V2 enforces that evaluator participation in the contract itself, so a direct client-plus-Liege refund call cannot bypass it.

## V2 contract behavior

- `factoryVersion` must be `2`; the escrow uses EIP-712 domain version `2`.
- The client, provider, evaluator, and Liege signer must be distinct addresses. In particular, a client address cannot stand in as the evaluator.
- `markSubmitted` stores the provider’s `deliverableCommit` and submission timestamp onchain.
- The provider’s V2 submission signature covers that exact commitment, terms hash, provider nonce, and deadline; a caller cannot substitute a different commitment.
- Post-submission release approvals are bound to the payout list, deliverable commitment, and submission timestamp.
- A post-submission refund is bound to the deliverable commitment and submission timestamp. It requires the evaluator plus one other outcome signer. Client plus Liege alone is rejected.
- Manual release or refund must happen by `submittedAt + evaluateWithin + 6 hours`.
- If the evaluator stays silent, the existing permissionless timeout releases the provider’s budget after `submittedAt + evaluateWithin + 72 hours + 6 hours`; the evaluator fee goes back to the client.
- Before work is submitted, the existing no-submission refund and timeout paths remain.

The evaluator is the independent decision-maker for post-submission refunds. This prevents the specific client-plus-Liege bypass, but it cannot prevent evaluator collusion. The committed hash proves which submission was referenced; it does not make offchain work or its quality independently verifiable.

## Required Liege integration changes

Keep V1 and V2 factory configuration separate so already-created V1 jobs continue to work. Recommended environment variables:

```env
VEILORA_ESCROW_FACTORY_ADDRESS=<existing V1 factory>
VEILORA_ESCROW_FACTORY_V2_ADDRESS=0x81E05B0Ee0229ac62ED4e3bc9242aa0b9Ac0830E
```

Update `backend/src/veiloraEscrow.ts` and related job routes to:

1. Create new job terms with `factoryVersion: 2`, predict and create them using the V2 factory, and persist the version in `veilora_escrow_terms`.
2. Select the factory by the stored terms version when verifying creation and funding. Do not reinterpret existing V1 jobs as V2.
3. Refuse to create a V2 escrow if no independent evaluator is assigned, or if its address equals the client, provider, or Liege signer. Remove the current client-as-evaluator fallback for V2.
4. For V2 EIP-712 signatures, use domain `VeiloraEscrow`, version `2`, chain ID `4663`, and the escrow address. Provider acceptance/decline actions use `hashProviderAction`; submissions use `hashProviderSubmission(deliverableCommit, deadline)` so the signature covers the precise commitment.
5. Calculate release approvals with the V2 `releasePayloadHash(payouts)` view helper, and refund approvals with `refundPayloadHash()`, then pass the returned payload hash to `hashOutcome`. V1 keeps its existing payload construction and domain version `1`.
6. Continue collecting an evaluator signature and Liege signature for both post-submission outcomes. Submit `[evaluatorSignature, liegeSignature]`; V2 independently checks the evaluator requirement for refunds.
7. Keep provider acceptance/submission signing aligned with the V2 EIP-712 domain version. The provider’s accept and submit signatures also use version `2`.

## Deployment and rollout

Veilora has deployed `VeiloraEscrowFactoryV2` to Robinhood Chain 4663 and verified its runtime code and `FACTORY_VERSION == 2`. Liege should wire the new environment variable, update its escrow ABI and outcome hashing, require distinct participants, and run backend CI before enabling V2 jobs.

V1 escrows are immutable and remain governed by their existing rules. V2 applies only to new escrows created by the V2 factory. Do not tell users the V2 protection is live until deployment and Liege production configuration are complete.
