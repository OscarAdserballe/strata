// TeX is lifted out before markdown parsing (shieldMath), since _ and \ are markdown syntax too.

import Markdown, { RuleType, type MarkdownToJSX } from "markdown-to-jsx";
import React from "react";
import { shieldMath, texify, unliteralize, unshieldMath } from "./text.ts";
import { MD_OPTIONS } from "./render.ts";
import { withMath } from "./math.tsx";
import { imagesInMarkdown, imgProps } from "./images.tsx";

const markdownOverrides: MarkdownToJSX.Overrides = {
  a: { props: { target: "_blank", rel: "noopener noreferrer" } },
  img: { props: imgProps },
  input: { props: { disabled: true, tabIndex: -1 } },
};

export function mdBlocks(raw: unknown, streaming = false) {
  const src = imagesInMarkdown(unliteralize(texify(String(raw || "").replace(/\r\n/g, "\n"))));
  const { text, spans } = shieldMath(src);
  return <Markdown options={{
    ...MD_OPTIONS,
    optimizeForStreaming: streaming,
    wrapper: "div",
    // The library types this as key-only; the wrapper div accepts any prop.
    wrapperProps: { className: "md" } as React.JSX.IntrinsicAttributes & { className: string },
    overrides: markdownOverrides,
    renderRule(next, node, _renderChildren, state) {
      if (!spans.length) return next();
      if (node.type === RuleType.text && node.text.includes("\uE000")) {
        return <React.Fragment key={state.key}>{withMath(node.text, spans, String(state.key))}</React.Fragment>;
      }
      // Outside text nodes (code, URLs, alt text), a math slot is restored to its raw characters.
      const fields = node as unknown as Record<string, unknown>;
      for (const k in fields) {
        const v = fields[k];
        if (typeof v === "string" && v.includes("\uE000")) fields[k] = unshieldMath(v, src, spans);
      }
      return next();
    },
  }}>{text}</Markdown>;
}
