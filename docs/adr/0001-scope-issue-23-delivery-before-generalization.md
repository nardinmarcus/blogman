# Scope the delivery module to Issue #23 before generalizing

Build one repository-owned deep module for Issue #23 Delivery rather than a generic Cloudflare release platform. The module owns Batch 1 preparation through terminal result; Batch 2–8 and arbitrary deployments remain outside it. Consider extracting a broader module only after this design completes an independently verified real T0, because generalizing before observed reuse would expose accidental clean-start, D1, and T0 details as a permanent interface.
