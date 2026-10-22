---
name: pr-manager
description: Creates GitHub issues, pushes PRs, conducts automated code reviews, and merges or closes PRs.
---
# PR Manager
1. Query `api.github.com/repos/el-jefe702/DepthForge/pulls` to fetch target PR diffs and status checks.
2. Check out the PR branch in `/workspace/depthforge` and execute the test suite.
3. Submit a formal PR review via the GitHub API evaluating 16-bit pipeline integrity, security, and SpatialOps architecture alignment.
4. If all checks pass, merge the PR via `PUT /repos/el-jefe702/DepthForge/pulls/{pull_number}/merge`. If the implementation is flawed, post a detailed explanation and close the PR via `PATCH`.
