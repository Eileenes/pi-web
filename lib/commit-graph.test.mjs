import assert from "node:assert/strict";
import test from "node:test";
import { buildCommitGraph } from "./commit-graph.ts";

/** 渲染成字符画便于断言：● 节点 │ 竖线 ─ 水平线 ╷/╵ 半线 */
function render(rows) {
  return rows.map((r) => {
    let line = "";
    const maxCol = Math.max(
      r.lanesBefore.length, r.lanesAfter.length, r.col + 1,
      ...r.merges.map((m) => m + 1), ...r.forks.map((f) => f + 1),
    );
    for (let j = 0; j < maxCol; j++) {
      if (r.col === j) line += "●";
      else if (r.merges.includes(j) || r.forks.includes(j)) line += "─";
      else if (r.lanesBefore[j] != null && r.lanesAfter[j] != null) line += "│";
      else if (r.lanesBefore[j] != null) line += "╵";
      else if (r.lanesAfter[j] != null) line += "╷";
      else line += " ";
    }
    return line;
  });
}

test("线性历史：单列竖线延续", () => {
  const rows = buildCommitGraph([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: [] },
  ]);
  assert.deepEqual(render(rows), ["●", "●", "●"]);
  assert.deepEqual(rows[0].lanesBefore, []);
  assert.deepEqual(rows[0].lanesAfter, ["b"]);
  assert.deepEqual(rows[1].lanesAfter, ["a"]);
  assert.deepEqual(rows[2].lanesAfter, []); // 无父，尾部空列被清理
});

test("合并提交：第一父继承本列，第二父分叉到新列，后合流", () => {
  const rows = buildCommitGraph([
    { hash: "C", parents: ["B", "A"] }, // merge
    { hash: "A", parents: ["D"] },
    { hash: "B", parents: ["D"] },
    { hash: "D", parents: [] },
  ]);
  assert.deepEqual(render(rows), ["●─", "│●", "●─", " ●"]);
  assert.equal(rows[0].isMerge, true);
  assert.equal(rows[0].col, 0);
  assert.deepEqual(rows[0].forks, [1]); // A 分叉到列 1
  assert.deepEqual(rows[1].col, 1);
  assert.deepEqual(rows[2].col, 0);
  assert.deepEqual(rows[2].forks, [1]); // B 并入 D 所在列
});

test("--all 分叉：独立分支 tip 落地后并入公共父", () => {
  const rows = buildCommitGraph([
    { hash: "C", parents: ["B"] },
    { hash: "B", parents: ["D"] },
    { hash: "A", parents: ["D"] }, // 另一分支 tip
    { hash: "D", parents: [] },
  ]);
  assert.deepEqual(render(rows), ["●", "●", "─●", "●"]);
  assert.equal(rows[2].col, 1);
  assert.deepEqual(rows[2].forks, [0]); // A 的线并入 D 所在列
});

test("octopus 合并（3 父）", () => {
  const rows = buildCommitGraph([
    { hash: "O", parents: ["P", "Q", "R"] },
    { hash: "R", parents: ["T"] },
    { hash: "Q", parents: ["T"] },
    { hash: "P", parents: ["T"] },
    { hash: "T", parents: [] },
  ]);
  assert.equal(rows[0].isMerge, true);
  assert.deepEqual(rows[0].forks, [1, 2]);
  assert.deepEqual(render(rows), ["●──", "││●", "│●─", "● ─", "  ●"]);
});

test("分页：未加载的父提交作为悬挂 hash 保留，加载后落地", () => {
  // 第一页：只有 c → b → a（a 的父 x 未加载）
  const page1 = buildCommitGraph([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: ["x"] },
  ]);
  assert.deepEqual(page1[2].lanesAfter, ["x"]); // x 悬挂

  // 加载更多后 x 出现：lanes 状态从头连续计算，x 落地
  const full = buildCommitGraph([
    { hash: "c", parents: ["b"] },
    { hash: "b", parents: ["a"] },
    { hash: "a", parents: ["x"] },
    { hash: "x", parents: [] },
  ]);
  assert.deepEqual(full[3].col, 0);
  assert.deepEqual(full[3].lanesBefore, ["x"]);
});

test("两个提交指向同一父：后处理的提交把线并入已有列", () => {
  // 真实 git 中 A、B 并列指向 M（--all 拓扑输出）
  const rows = buildCommitGraph([
    { hash: "A", parents: ["M"] },
    { hash: "B", parents: ["M"] },
    { hash: "M", parents: [] },
  ]);
  assert.deepEqual(render(rows), ["●", "─●", "●"]);
  assert.deepEqual(rows[1].col, 1);
  assert.deepEqual(rows[1].forks, [0]); // B 的线并入 M 所在列
});
