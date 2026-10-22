---
name: pr-manager
description: Handles GitHub issue creation, PR submission, code review, and merge execution.
---

# PR Manager

When handling issues or pull requests:
1. **Fetch & Inspect**: Use GitHub API or git CLI to inspect issue requirements, PR diffs, and CI status.
2. **Review**: Ensure full alignment with SpatialOps standards (Graphite v3 design system, 16-bit depth map precision, clean error handling).
3. **Approve / Request Changes**: Submit explicit, constructive code reviews with test evidence.
4. **Merge / Close**: Execute merges if all automated tests and quality gates pass; close PRs with an explanatory rationale if architecturally misaligned.
