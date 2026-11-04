// A space's folders as its maintainer sees them: the documents each holds directly, the level
// they follow, and the documents set on their own.

import type { DocumentEntry, DocumentTree, DocumentTreeNode, GovernanceLevel } from "@inspiration/contracts";
import { expect, test } from "vitest";
import { folderRows } from "../src/folders.ts";

const SOURCE = "src_POLICIES";

function doc(path: string[], title: string, level: GovernanceLevel): DocumentTreeNode {
  const entry = { source_id: SOURCE, external_id: [...path, title].join("/"), title, governance_level: level };
  return { kind: "document", name: title, source_id: SOURCE, path: [...path, title], document: entry as DocumentEntry };
}

const folder = (path: string[], children: DocumentTreeNode[]): DocumentTreeNode => ({
  kind: "folder",
  name: path.at(-1) as string,
  source_id: SOURCE,
  path,
  children,
});

test("a folder's documents follow its level, and one set on its own is named", () => {
  const tree: DocumentTree = {
    space_id: "spc_POLICY",
    sources: [
      {
        kind: "source",
        name: "Policies",
        source_id: SOURCE,
        path: [],
        children: [
          doc([], "Handbook", "reference"),
          folder(
            ["Finance"],
            [
              doc(["Finance"], "Travel", "governed"),
              doc(["Finance"], "Expenses", "governed"),
              doc(["Finance"], "Travel (forwarded)", "reference"),
              folder(["Finance", "Internal"], [doc(["Finance", "Internal"], "Budget", "governed")]),
            ],
          ),
          folder(["Empty"], []),
        ],
      },
    ],
  };
  expect(
    folderRows(tree).map((r) => [r.path.join("/"), r.documents.length, r.level, r.own.map((d) => d.title)]),
  ).toEqual([
    ["", 1, "reference", []],
    ["Finance", 3, "governed", ["Travel (forwarded)"]],
    ["Finance/Internal", 1, "governed", []],
  ]);
  expect(folderRows(tree)[0]?.source).toBe("Policies");
});

test("on a tie, the level that governs more is the folder's", () => {
  const tree: DocumentTree = {
    space_id: "spc_POLICY",
    sources: [
      {
        kind: "source",
        name: "Wiki",
        source_id: SOURCE,
        path: [],
        children: [doc([], "Minutes", "reference"), doc([], "Guide", "governed")],
      },
    ],
  };
  expect(folderRows(tree).map((r) => [r.level, r.own.map((d) => d.title)])).toEqual([["governed", ["Minutes"]]]);
});
