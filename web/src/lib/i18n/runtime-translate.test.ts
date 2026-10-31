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
