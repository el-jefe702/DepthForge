import os
from google import genai

client = genai.Client()

github_pat = os.getenv("GITHUB_PAT") or os.getenv("GITHUB_TOKEN") or "YOUR_GITHUB_PAT"

# 1. Remove the existing agent configuration if it already exists
existing_ids = [a.id for a in (client.agents.list().agents or [])]
for old_id in ("depthforge-lead-engineer", "depthforge-argon-engineer"):
    if old_id in existing_ids:
        client.agents.delete(id=old_id)
        print(f"Removed old agent config: {old_id}")

# 2. Recreate depthforge-lead-engineer powered by Gemini 4 Argon
agent = client.agents.create(
    id="depthforge-lead-engineer",
    description="Autonomous Gemini 4 Argon lead engineering and bootstrapping agent for DepthForge (SpatialOps, LLC).",
    base_agent="antigravity-preview-09-2026",
    agent_config={
        "type": "antigravity",
        "model": "gemini-4-argon",
    },
    system_instruction=(
        "You are the Lead Autonomous Engineer for SpatialOps, LLC, managing https://depthforge.spatialops.llc "
        "(el-jefe702/DepthForge). Before making irreversible changes, run a pre-flight check and verify all fixes "
        "against reproducible test scripts. Maintain a direct, no-fluff engineering tone aligned with SpatialOps."
    ),
    base_environment={
        "type": "remote",
        "network": {
            "allowlist": [
                {
                    "domain": "api.github.com",
                    "transform": {
                        "Authorization": f"Bearer {github_pat}"
                    },
                },
                {"domain": "github.com"},
                {"domain": "depthforge.spatialops.llc"},
                {"domain": "pypi.org"},
                {"domain": "registry.npmjs.org"},
            ]
        },
        "sources": [
            {
                "type": "repository",
                "source": "https://github.com/el-jefe702/DepthForge",
                "target": "/workspace/depthforge",
            },
            {
                "type": "inline",
                "target": ".agents/AGENTS.md",
                "content": open(".agents/AGENTS.md", "r", encoding="utf-8").read(),
            },
            {
                "type": "inline",
                "target": ".agents/skills/audit-and-repair/SKILL.md",
                "content": open(".agents/skills/audit-and-repair/SKILL.md", "r", encoding="utf-8").read(),
            },
            {
                "type": "inline",
                "target": ".agents/skills/pr-manager/SKILL.md",
                "content": open(".agents/skills/pr-manager/SKILL.md", "r", encoding="utf-8").read(),
            },
            {
                "type": "inline",
                "target": ".agents/skills/monetization-researcher/SKILL.md",
                "content": open(".agents/skills/monetization-researcher/SKILL.md", "r", encoding="utf-8").read(),
            },
        ],
    },
)

print(f"Upgraded and deployed Argon agent: {agent.id}")
