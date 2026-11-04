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

  // Settings → Services → Python package mirror. These four are copied from
  // the rendered page, not from the JSX: a card added without dictionary
  // entries looks correct in source review and ships in English, which is how
  // this one was missed.
  const mirror: [string, string][] = [
    ["Python package mirror", "Python 包镜像"],
    ["Package index URL", "包索引地址"],
    [
      "Only needed where downloading from PyPI is slow. The first launch installs about 550 MB of scientific packages; on a slow link that can take much longer than starting the app again ever will.",
      "仅在从 PyPI 下载缓慢时才需要",
    ],
    [
      "Leave unset to download from PyPI itself. Versions and checksums stay pinned by Kady's lockfile — this only changes where the files come from. Applies to the next launch.",
      "留空则从 PyPI 官方源下载",
    ],
  ];
  it.each(mirror)("translates the mirror card: %s", (english, expectedFragment) => {
    expect(translateText(m, english)).toContain(expectedFragment);
  });

  // Settings → Providers → Custom model servers. Same failure mode as the
  // mirror card: the JSX was translated-aware only by luck, so the two
  // collapsible section headings shipped in English.
  const customModel: [string, string][] = [
    ["Thinking levels", "思考档位"],
    ["Level mapping", "档位映射"],
    ["Adaptive thinking (effort instead of token budget)", "自适应思考"],
  ];
  it.each(customModel)("translates the custom-model card: %s", (english, expectedFragment) => {
    expect(translateText(m, english)).toContain(expectedFragment);
  });
});
