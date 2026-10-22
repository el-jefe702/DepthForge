import os
from google import genai

client = genai.Client()

github_pat = os.getenv("GITHUB_PAT") or os.getenv("GITHUB_TOKEN") or "YOUR_GITHUB_PAT"

agent = client.agents.create(
    id="depthforge-lead-engineer",
    base_agent="antigravity-preview-09-2026",
    agent_config={
        "type": "antigravity",
        "model": "gemini-3.8-flash",
    },
    system_instruction=(
        "You are the Lead AI Engineer for SpatialOps, LLC, specializing in the DepthForge application. "
        "Your core directive is to advance a platform that generates 16-bit grayscale heightmaps for CNC routers "
        "and CO2 laser engravers. You have deep expertise in Python, FastAPI, OpenCV processing pipelines, React, "
        "Three.js 3D displacement previews, and LightBurn (.lbrn2) integration. You operate autonomously to write code, "
        "push commits to the el-jefe702 GitHub repositories, open Pull Requests, review external or staged PRs, and merge "
        "or close them based on code quality and alignment with the high-contrast, precision-focused branding of SpatialOps. "
        "You also continuously evaluate the market to recommend bootstrapping monetization strategies for a single-member R&D firm."
    ),
    base_environment={
        "type": "remote",
        "network": {
            "allowlist": [
                {
                    "domain": "api.github.com",
                    "transform": {
                        "Authorization": f"Bearer {github_pat}"
                    }
                },
                {"domain": "github.com"},
                {"domain": "pypi.org"},
                {"domain": "npmjs.com"}
            ]
        },
        "sources": [
            {
                "type": "inline",
                "target": ".agents/skills/audit-and-repair/SKILL.md",
                "content": open(".agents/skills/audit-and-repair/SKILL.md", "r", encoding="utf-8").read()
            },
            {
                "type": "inline",
                "target": ".agents/skills/pr-manager/SKILL.md",
                "content": open(".agents/skills/pr-manager/SKILL.md", "r", encoding="utf-8").read()
            },
            {
                "type": "inline",
                "target": ".agents/skills/monetization-researcher/SKILL.md",
                "content": open(".agents/skills/monetization-researcher/SKILL.md", "r", encoding="utf-8").read()
            }
        ]
    }
)

print(f"Agent successfully deployed. ID: {agent.id}")
