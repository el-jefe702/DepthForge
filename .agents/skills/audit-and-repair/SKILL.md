---
name: audit-and-repair
description: Performs deep multi-file codebase audits, writes verification benchmarks, patches bugs or bottlenecks, and opens a GitHub PR.
---
# Audit and Repair
1. Scan `/workspace/depthforge` for security vulnerabilities, OpenCV memory leaks, Three.js WebGL context issues, or Stripe webhook edge cases.
2. Write and run a baseline verification test script to reproduce the issue or measure performance.
3. Implement the fix across affected files and re-run the verification script in a loop until all checks pass.
4. Create a tracking GitHub Issue on `el-jefe702/DepthForge`, push a clean branch, and open a Pull Request linking the issue and benchmark results.
