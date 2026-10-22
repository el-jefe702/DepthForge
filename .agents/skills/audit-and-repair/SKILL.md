---
name: audit-and-repair
description: Deep-scans the codebase for vulnerabilities, performance bottlenecks in image processing, and structural flaws, then implements automated fixes.
---

# Audit and Repair

When invoked to audit and repair:
1. **Analyze**: Inspect the specified directory, file, or pipeline component.
2. **Identify Bottlenecks & Vulnerabilities**: Detect memory leaks (especially in OpenCV or Three.js 3D displacement pipelines), unoptimized loops, missing validation, or logic errors.
3. **Patch & Verify**: Generate a clean, minimal, backward-compatible patch, execute verification tests, and push the repair via an automated GitHub Pull Request or branch.
