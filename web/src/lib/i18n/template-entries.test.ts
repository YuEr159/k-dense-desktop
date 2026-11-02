import { describe, expect, it } from "vitest";
import zh from "./zh-CN.json";
import { buildMatcher, translateText } from "./runtime-translate";

const m = buildMatcher(zh);

// Sentences a component renders as text plus inline markup (`<code>`, `<a>`,
// `<span>`) never reach the matcher whole: `flattenInline` turns each child
// element into a `{n}` slot, so the entry must be written in that flattened
// form. These rows are what the DOM actually produces, which is the half a
// hand-written key gets wrong — the source JSX reads like one sentence.
const cases: [string, string][] = [
  [
    "Reusable prompts that expand from /name args in the composer. Type / in the chat to pick one; add arguments after the name (/qc user_data/a.csv) and use $1, $2… or $ARGUMENTS in the body. A project template shadows a shared one of the same name.",
    "可复用提示词",
  ],
  [
    "Specialist agents Kady can delegate to with the subagent tool, configured per project (current: 随便聊聊) as markdown files in .pi/agents/.",
    "专家代理",
  ],
  [
    "A second model reviews what the agent just did and steers findings into the chat: raw data touched, silent row drops, unlogged parameter changes, claims without evidence. Per project; applies to new chat tabs.",
    "复核",
  ],
  // The heading is "Built-in specialists " plus an inline <span>, so the
  // flattened form the matcher sees is a {0} template; the span's own copy is
  // a separate entry translated in place.
  ["Built-in specialists {0}", "内置专家"],
  ["(from pi-subagents — customize to override)", "自定义即可覆盖"],
  [
    "Named OpenRouter Fusion setups appear at the top of the model picker. Paste the full Fusion request body (see the OpenRouter Fusion docs). Fusion needs OpenRouter access and is saved in this browser only.",
    "模型选择器顶部",
  ],
  [
    "A few knobs are read from .env at startup only — e.g. GITHUB_TOKEN (update checks) and HTTPS_PROXY (outbound proxy). Restart Kady after changing them.",
    "启动时",
  ],
];

describe("multi-node templates", () => {
  it.each(cases)("translates %s", (english, expectedFragment) => {
    expect(translateText(m, english)).toContain(expectedFragment);
  });
});
