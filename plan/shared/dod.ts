// Definition of Done text grammar (pure; shared by the server and the client bundle). Every
// non-blank line is one item: `- [check] <command>` is an automated check run by the server, and
// any other line is a review criterion. Nothing is informational.

export type DodItem = { index: number; kind: "check" | "criterion"; text: string; command?: string };

const CHECK_RE = /^- \[check\]\s+(\S.*)$/;

/** Splits on `\n`, strips `\r`, trims each line and skips blank lines; indexes count emitted items. */
export function parseDod(text: string): { items: DodItem[] } {
  const items: DodItem[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    if (line === "") continue;
    const match = CHECK_RE.exec(line);
    items.push(
      match
        ? { index: items.length, kind: "check", text: line, command: match[1].trim() }
        : { index: items.length, kind: "criterion", text: line },
    );
  }
  return { items };
}
