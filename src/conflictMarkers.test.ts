import { describe, expect, it } from "vitest";

import {
  buildResolvedConflictText,
  parseConflictWorktreeText,
  withResolvedEmptySelection,
} from "./conflictMarkers";

describe("conflict marker resolution", () => {
  it("produces a truly empty file when the only conflict is resolved as empty", () => {
    const parsed = parseConflictWorktreeText(
      "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n",
    );

    expect(parsed).not.toBeNull();
    expect(buildResolvedConflictText(parsed!, { 1: withResolvedEmptySelection() })).toBe("");
  });

  it("preserves a trailing CRLF when resolved content remains", () => {
    const parsed = parseConflictWorktreeText(
      "before\r\n<<<<<<< ours\r\nleft\r\n=======\r\nright\r\n>>>>>>> theirs\r\nafter\r\n",
    );

    expect(parsed).not.toBeNull();
    expect(
      buildResolvedConflictText(parsed!, {
        1: { oursLineNumbers: [2], theirsLineNumbers: [], resolvedAsEmpty: false },
      }),
    ).toBe("before\r\nleft\r\nafter\r\n");
  });

  it("does not assemble a file while any conflict remains unresolved", () => {
    const parsed = parseConflictWorktreeText(
      "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n",
    );

    expect(parsed).not.toBeNull();
    expect(buildResolvedConflictText(parsed!, {})).toBeNull();
  });
});
