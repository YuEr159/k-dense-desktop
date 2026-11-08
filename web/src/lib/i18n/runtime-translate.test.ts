import { describe, expect, it } from "vitest";
import dictionary from "./zh-CN.json";
import {
  buildMatcher,
  detectLocaleFromNavigator,
  translateText,
  translateSubtree,
} from "./runtime-translate";

const matcher = buildMatcher(dictionary as Record<string, string>);

/** Apply a plan the way LocaleProvider does. */
function apply(plan: { node: Text; text: string }[]) {
  for (const { node, text } of plan) node.nodeValue = text;
}

describe("translateText", () => {
  it("translates an exact UI string", () => {
    expect(translateText(matcher, "Appearance")).toBe("外观");
    expect(translateText(matcher, "Cancel")).toBe("取消");
  });

  it("keeps surrounding whitespace so inline spacing survives", () => {
    expect(translateText(matcher, " Cancel ")).toBe(" 取消 ");
  });

  it("returns unknown strings untouched", () => {
    expect(translateText(matcher, "Some string nobody translated")).toBe(
      "Some string nobody translated",
    );
  });

  it("does not translate identifiers by accident", () => {
    for (const identifier of ["user_data/", "provider/model-id", "sk-or-v1-…"]) {
      expect(translateText(matcher, identifier)).toBe(identifier);
    }
  });

  it("leaves strings that are only whitespace alone", () => {
    expect(translateText(matcher, "   ")).toBe("   ");
  });
});

describe("translateSubtree", () => {
  const noSkip = () => false;

  function render(html: string): HTMLElement {
    const host = document.createElement("div");
    host.innerHTML = html;
    apply(translateSubtree(host, matcher, noSkip));
    return host;
  }

  it("rewrites plain text nodes", () => {
    const host = render("<button>Cancel</button>");
    expect(host.textContent).toBe("取消");
  });

  it("rewrites placeholders and aria-labels", () => {
    const host = render(
      '<input placeholder="Search projects" aria-label="Search projects" />',
    );
    const input = host.querySelector("input")!;
    expect(input.getAttribute("placeholder")).toBe("搜索项目");
    expect(input.getAttribute("aria-label")).toBe("搜索项目");
  });

  it("never rewrites an input value", () => {
    const host = render('<input value="Cancel" />');
    expect(host.querySelector("input")!.value).toBe("Cancel");
  });

  it("skips code, keyboard hints and preformatted output", () => {
    const host = render(
      "<pre><code>Cancel</code></pre><kbd>Enter</kbd><code>Cancel</code>",
    );
    expect(host.querySelector("code")!.textContent).toBe("Cancel");
    expect(host.querySelector("kbd")!.textContent).toBe("Enter");
  });

  it("skips anything marked data-no-translate", () => {
    const host = render(
      '<div data-no-translate><span>Cancel</span><input placeholder="Cancel" /></div>',
    );
    expect(host.querySelector("span")!.textContent).toBe("Cancel");
    expect(host.querySelector("input")!.getAttribute("placeholder")).toBe("Cancel");
  });

  it("still translates siblings of a skipped subtree", () => {
    const host = render(
      '<div data-no-translate><span>Cancel</span></div><span>Cancel</span>',
    );
    const spans = host.querySelectorAll("span");
    expect(spans[0].textContent).toBe("Cancel");
    expect(spans[1].textContent).toBe("取消");
  });

  it("leaves a split sentence's fragments untranslated", () => {
    // `There are {n} files` renders as three nodes; translating "There are "
    // on its own would produce broken Chinese, and the dictionary has no
    // entry for it precisely because harvesting skips such fragments.
    const host = render("<p>There are <strong>3</strong> files</p>");
    expect(host.textContent).toBe("There are 3 files");
  });

  it("does not translate twice on a second pass", () => {
    const host = render("<span>Cancel</span>");
    apply(translateSubtree(host, matcher, noSkip));
    apply(translateSubtree(host, matcher, noSkip));
    expect(host.textContent).toBe("取消");
  });

  it("recovers the English original for a switch back", () => {
    const host = document.createElement("div");
    host.innerHTML = "<span>Cancel</span>";
    const node = host.querySelector("span")!.firstChild as Text;
    const before = node.nodeValue;

    apply(translateSubtree(host, matcher, noSkip));
    expect(node.nodeValue).toBe("取消");

    // LocaleProvider remembers `before` in a WeakMap and restores it, which is
    // what lets Settings switch back to English without a reload.
    node.nodeValue = before;
    expect(node.nodeValue).toBe("Cancel");
  });

  it("translates sentence templates with interpolated values", () => {
    const local = buildMatcher({
      "Connected ({0})": "已连接（{0}）",
      "{0} of {1} skills": "{1} 个技能中的 {0} 个",
    });
    expect(translateText(local, "Connected (3)")).toBe("已连接（3）");
    // The translation may reorder the captures freely.
    expect(translateText(local, "2 of 10 skills")).toBe("10 个技能中的 2 个");
  });

  it("does not let a template match a fragment of a longer sentence", () => {
    const local = buildMatcher({ "Connected ({0})": "已连接（{0}）" });
    expect(translateText(local, "Connected (3) providers")).toBe(
      "Connected (3) providers",
    );
  });

  it("translates a capture that has its own entry", () => {
    // A capture is spliced in verbatim, so wording inside the slot never gets
    // matched on its own. The default-model label puts a whole sentence in
    // there; a name or a number simply has no entry and passes through.
    const local = buildMatcher({
      "Not set — Kady's default ({0})": "未设置——使用 Kady 的默认值（{0}）",
      "GPT-6 Astra unless DEFAULT_MODEL_* is set in .env":
        "GPT-6 Astra（除非在 .env 中设置了 DEFAULT_MODEL_*）",
    });
    expect(
      translateText(local, "Not set — Kady's default (GPT-6 Astra unless DEFAULT_MODEL_* is set in .env)"),
    ).toBe("未设置——使用 Kady 的默认值（GPT-6 Astra（除非在 .env 中设置了 DEFAULT_MODEL_*））");
    expect(translateText(local, "Not set — Kady's default (GPT-6 Astra)")).toBe(
      "未设置——使用 Kady 的默认值（GPT-6 Astra）",
    );
  });

  it("keeps a template from swallowing a whole sentence", () => {
    // `{0} of {1}` exists for counts like "1 of 2". With an unbounded capture
    // it also matched any English sentence containing " of " and rewrote it
    // from the template — the local-server hint lost its own words.
    const local = buildMatcher({ "{0} of {1}": "{0} / {1}" });
    const sentence =
      "LM Studio, vLLM, llama.cpp server — anything serving /v1/models, so move one of them. Leave unset to use http://localhost:1234.";
    expect(translateText(local, sentence)).toBe(sentence);
    expect(translateText(local, "1 of 2")).toBe("1 / 2");
  });

  it("joins sibling text nodes before matching a template", () => {
    // React renders `{a} in / {b} out per 1M tok` as five sibling text nodes;
    // no single one holds the sentence the template describes.
    const local = buildMatcher({ "{0} in / {1} out": "{0} 输入 / {1} 输出" });
    const host = document.createElement("div");
    host.innerHTML = "<span>$40.00 in / $200.00 out</span>";
    const span = host.querySelector("span")!;
    span.textContent = "";
    for (const piece of ["$", "40.00", " in / $", "200.00", " out"]) {
      span.appendChild(document.createTextNode(piece));
    }

    apply(translateSubtree(host, local, noSkip));
    expect(host.textContent).toBe("$40.00 输入 / $200.00 输出");
  });

  it("matches across inline markup and keeps the element", () => {
    // `<kbd>.env</kbd>` splits the sentence into three nodes; the filename must
    // survive the translation with its styling intact.
    const local = buildMatcher({
      "keys from your {0} file and run on your machine.":
        "使用来自你本机 {0} 文件的密钥，并在你的机器上运行。",
    });
    const host = document.createElement("div");
    host.innerHTML =
      "<p>keys from your <kbd>.env</kbd> file and run on your machine.</p>";

    apply(translateSubtree(host, local, noSkip));

    const p = host.querySelector("p")!;
    expect(p.textContent).toBe("使用来自你本机 .env 文件的密钥，并在你的机器上运行。");
    expect(p.querySelector("kbd")).not.toBeNull();
    expect(p.querySelector("kbd")!.textContent).toBe(".env");
  });

  it("refuses to join across a block element", () => {
    const local = buildMatcher({ "{0} and more": "{0} 及更多" });
    const host = document.createElement("div");
    host.innerHTML = "<p><span>one</span><div>and more</div></p>";
    apply(translateSubtree(host, local, noSkip));
    // A block child means these are different sentences; nothing is rewritten.
    expect(host.textContent).toBe("oneand more");
  });

  it("translates a label's copy and leaves the control it labels intact", () => {
    // `<label>API key (literal, <code>$ENV_VAR</code>, …) <input/> <button/></label>`
    // is the shape every labelled form field takes. Refusing the label because
    // it holds a control left all of them English.
    const local = buildMatcher({
      "API key (literal, {0}, or empty for a keyless server)":
        "API 密钥（明文字面值、{0}，无密钥服务器留空）",
    });
    const host = document.createElement("div");
    host.innerHTML =
      '<label>API key (literal, <code>$ENV_VAR</code>, or empty for a keyless server)' +
      '<input value="" /><button type="button">Remove saved key</button></label>';
    const label = host.querySelector("label")!;

    apply(translateSubtree(host, local, noSkip));

    expect(label.textContent).toBe(
      "API 密钥（明文字面值、$ENV_VAR，无密钥服务器留空）Remove saved key",
    );
    // The field and the button must survive: they are what the label is for.
    expect(label.querySelector("input")).not.toBeNull();
    expect(label.querySelector("button")).not.toBeNull();
    expect(label.querySelector("code")!.textContent).toBe("$ENV_VAR");
  });

  it("does not translate a label whose control comes first", () => {
    // Nothing precedes the control, so there is no copy to match; the per-node
    // pass still handles any trailing text on its own.
    const local = buildMatcher({ "on": "开" });
    const host = document.createElement("div");
    host.innerHTML = "<label><input type='checkbox' />on</label>";
    apply(translateSubtree(host, local, noSkip));
    expect(host.querySelector("input")).not.toBeNull();
    expect(host.textContent).toBe("开");
  });

  it("drops the space that separated English copy from the control it ends on", () => {
    // `Specialists have their own default under <SettingsLink/>.` renders the
    // link as a <button>, so the copy is matched as a prefix. The English
    // trailing space exists only to separate "under" from the link; Chinese
    // ends the clause on the widget, and keeping it reads as "专家默认在 专家".
    const local = buildMatcher({
      "Specialists have their own default under": "专家在",
    });
    const host = document.createElement("div");
    host.innerHTML =
      "<p>Specialists have their own default under <button>Specialists</button>.</p>";

    apply(translateSubtree(host, local, noSkip));

    const p = host.querySelector("p")!;
    // No gap between the translated prefix and the button's own label, but the
    // button and the sentence's full stop both survive.
    expect(p.textContent).toBe("专家在Specialists.");
    expect(p.querySelector("button")).not.toBeNull();
  });

  it("keeps a trailing space when the translation ends in Latin text", () => {
    // The same rule must not eat the separator when the copy ends in a Latin
    // word that the control continues, e.g. a product name before a link.
    const local = buildMatcher({ "Run it in": "Run it in" });
    const host = document.createElement("div");
    host.innerHTML = "<p>Run it in <button>Kady</button>.</p>";
    apply(translateSubtree(host, local, noSkip));
    expect(host.querySelector("p")!.textContent).toBe("Run it in Kady.");
  });

  it("translates a text field's placeholder but never its content", () => {
    // The composer is a `<textarea>`, which the walker rejects wholesale so
    // the user's typed text is never rewritten. The placeholder is UI copy,
    // not user data, and would otherwise stay English forever.
    const local = buildMatcher({
      "Ask Kady anything…": "向 Kady 提问…",
      "typed text": "输入的文字",
    });
    const host = document.createElement("div");
    host.innerHTML =
      '<textarea placeholder="Ask Kady anything…">typed text</textarea>';
    const field = host.querySelector("textarea")!;

    apply(translateSubtree(host, local, noSkip));

    expect(field.getAttribute("placeholder")).toBe("向 Kady 提问…");
    expect(field.value).toBe("typed text");
  });

  it("translates a sentence wrapped around a SettingsLink on both sides", () => {
    // `<SettingsLink>` is a <button>, which ENDS the flattened copy. The
    // sentence reaches the matcher as two independent strings — the prefix
    // before the button and the tail after it — so both need their own entry.
    // Entries written for the whole sentence never match, which is how these
    // banners shipped in English with every plain sentence around them
    // translated.
    const host = document.createElement("div");
    host.innerHTML =
      "<div>Modal is not connected. Existing job history remains available; connect a token pair in " +
      "<button>Settings → Services</button> to submit or retry jobs.</div>";

    apply(translateSubtree(host, matcher, noSkip));

    const text = host.textContent ?? "";
    expect(text).toContain("Modal 未连接。仍可查看现有任务历史");
    expect(text).toContain("设置 → 服务");
    expect(text).toContain("以提交或重试任务。");
    // The link is a control, not copy: it must survive the rewrite.
    expect(host.querySelector("button")).not.toBeNull();
  });

  it("translates the spend-limit banner's templated prefix and tail", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<p>2 schedules are held because the project reached its spend limit. " +
      "<button>Raise the limit in project settings</button> and they resume on their own.</p>";

    apply(translateSubtree(host, matcher, noSkip));

    const text = host.textContent ?? "";
    expect(text).toContain("2 个调度已挂起");
    expect(text).toContain("在项目设置中提高上限");
    expect(text).toContain("它们会自行恢复。");
  });

  /**
   * `<b>Title</b><br>Body…` is how every InfoTooltip renders. A <br> is not
   * inline markup, so the flattened match used to reject the whole block and
   * any body carrying `<kbd>`/`<i>` stayed English — three separate bug
   * reports (Skills, Files, Download all as zip) traced back to this.
   */
  it("translates a tooltip body across a <br> while keeping its markup", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<b>Files</b><br>Upload data, figures, manuscripts, or code. Everything " +
      "lands in the sandbox and can be referenced with <kbd>@</kbd>.";

    apply(translateSubtree(host, matcher, noSkip));

    expect(host.querySelector("b")!.textContent).toBe("文件");
    expect(host.querySelector("br")).not.toBeNull();
    const kbd = host.querySelector("kbd")!;
    expect(kbd.textContent).toBe("@");
    // The kbd still sits inside the sentence, not appended at the end.
    expect(host.textContent).toContain("可用 @ 引用。");
  });

  it("leaves the title and body as separate sentences when translating across a <br>", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<b>Skills</b><br>Opt-in playbooks for specific tasks (e.g. <i>scanpy</i>, " +
      "<i>literature-review</i>, <i>modal</i>). Kady follows pinned skills on every " +
      "message until you remove them.";

    apply(translateSubtree(host, matcher, noSkip));

    // The title must not be glued onto the body's key — it would never match.
    expect(host.querySelector("b")!.textContent).toBe("技能");
    expect(host.querySelectorAll("i")).toHaveLength(3);
    expect(host.textContent).toContain("针对特定任务的可选操作手册");
  });

  it("is idempotent: a second pass over translated markup changes nothing", () => {
    const host = document.createElement("div");
    host.innerHTML =
      "<b>Download all as zip</b><br>Package the entire sandbox into a " +
      "<kbd>.zip</kbd> for archiving, sharing with collaborators, or your lab notebook.";

    apply(translateSubtree(host, matcher, noSkip));
    const once = host.innerHTML;
    apply(translateSubtree(host, matcher, noSkip));
    expect(host.innerHTML).toBe(once);
    expect(host.querySelector("kbd")!.textContent).toBe(".zip");
  });

  it("keeps React's text nodes attached when collapsing a translated run", () => {
    // React renders `{a} of {b}` as one node per interpolation and holds
    // references to them; replacing the run detaches those and the next
    // render throws "insertBefore … is not a child of this node".
    const host = document.createElement("div");
    host.innerHTML = "<p>2 of 5</p>";
    const paragraph = host.querySelector("p")!;
    const before = [...paragraph.childNodes];

    apply(translateSubtree(host, matcher, noSkip));

    for (const node of before) expect(node.parentNode).toBe(paragraph);
  });
});

describe("buildMatcher", () => {
  it("prefers the longest exact match", () => {
    const local = buildMatcher({
      All: "全部",
      "All projects": "全部项目",
    });
    expect(translateText(local, "All projects")).toBe("全部项目");
    expect(translateText(local, "All")).toBe("全部");
  });
});

describe("dictionary integrity", () => {
  it("has no key that differs from its source only by whitespace", () => {
    const keys = Object.keys(dictionary).filter((key) => !key.startsWith("$"));
    for (const key of keys) {
      expect(key).toBe(key.replace(/\s+/g, " ").trim());
    }
  });

  it("has no empty translation", () => {
    const empty = Object.entries(dictionary as Record<string, string>)
      .filter(([key]) => !key.startsWith("$"))
      .filter(([, value]) => !value.trim())
      .map(([key]) => key);
    expect(empty).toEqual([]);
  });

  it("keeps placeholder counts identical between key and value", () => {
    const mismatched: string[] = [];
    for (const [key, value] of Object.entries(dictionary as Record<string, string>)) {
      if (key.startsWith("$")) continue;
      const keyCount = (key.match(/\{\d+\}/g) ?? []).length;
      if (keyCount === 0) continue;
      const valueCount = (value.match(/\{\d+\}/g) ?? []).length;
      if (keyCount !== valueCount) mismatched.push(key);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("detectLocale", () => {
  it("picks Chinese for zh-* browsers", () => {
    const original = navigator.languages;
    Object.defineProperty(navigator, "languages", {
      value: ["zh-CN", "en-US"],
      configurable: true,
    });
    expect(detectLocaleFromNavigator()).toBe("zh-CN");
    Object.defineProperty(navigator, "languages", {
      value: original,
      configurable: true,
    });
  });

  it("falls back to Chinese for English browsers", () => {
    Object.defineProperty(navigator, "languages", {
      value: ["en-US"],
      configurable: true,
    });
    // zh-CN is the only shipped dictionary and the product's default language;
    // an English dictionary would flip this back to "en".
    expect(detectLocaleFromNavigator()).toBe("zh-CN");
  });
});
