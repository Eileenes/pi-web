/**
 * 提交图 lane 布局算法（gitk / `git log --graph` 风格）。
 *
 * 输入：按 git log 拓扑顺序排列的提交（每项含 hash 与 parents）。
 * 输出：每行一个 GraphRow，描述该行各列的竖线、节点列、合流/分叉水平线，
 * 由渲染层绘制成 VSCode 风格的提交图。
 *
 * 算法要点：
 * - lanes 数组的每个槽位是一"列"，存有该列当前"悬挂"的 commit hash
 *   （该 commit 将在后续行出现，线从上一行延续到它出现的位置）。
 * - 每个 commit 出现时：若已在某列则落地该列；否则作为新分叉起点分配
 *   最左空位或新列。其第一父继承本列，其余父分配到空位/新列（分叉），
 *   被消耗的其它列（合流）置空。
 * - 支持分页：未加载到的父提交会作为"悬挂" hash 保留在 lanesAfter 中，
 *   加载更多后自然落地，连线跨页延续。
 */

export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphRow {
  /** 提交节点所在列 */
  col: number;
  /** 进入本行时各列挂起的 commit hash（null = 空槽） */
  lanesBefore: (string | null)[];
  /** 离开本行时各列挂起的 commit hash */
  lanesAfter: (string | null)[];
  /** 合流列：从这些列画水平线并入节点列 */
  merges: number[];
  /** 分叉列：从节点列画水平线分流到这些列（父提交所在的新列/既有列） */
  forks: number[];
  /** 是否为合并提交（父数量 > 1） */
  isMerge: boolean;
}

export function buildCommitGraph(commits: GraphCommit[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();

    let col = lanes.indexOf(commit.hash);
    if (col === -1) {
      // 新分叉起点（如 --all 下另一分支 tip）：优先复用最左空位，否则新增列
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(commit.hash);
      } else {
        lanes[col] = commit.hash;
      }
    }

    // 合流列：其它列挂起的正是本 commit（多条线在本行落地）
    const merges: number[] = [];
    for (let j = 0; j < lanes.length; j++) {
      if (j !== col && lanes[j] === commit.hash) merges.push(j);
    }

    const forks: number[] = [];
    const parents = commit.parents;
    if (parents.length === 0) {
      // 无父：本列线终止
      lanes[col] = null;
    } else {
      const firstParent = parents[0];
      const existingCol = lanes.indexOf(firstParent);
      if (existingCol !== -1 && existingCol !== col) {
        // 第一父已挂在其它列（合流场景：两条线汇向同一父提交）→ 本列线并入该列
        lanes[col] = null;
        forks.push(existingCol);
      } else {
        lanes[col] = firstParent;
      }
      // 其余父（合并提交）：分配到最左空位或新增列
      for (let i = 1; i < parents.length; i++) {
        const p = parents[i];
        const existing = lanes.indexOf(p);
        if (existing !== -1 && existing !== col) {
          forks.push(existing);
          continue;
        }
        let slot = lanes.indexOf(null);
        if (slot === -1) {
          slot = lanes.length;
          lanes.push(null);
        }
        lanes[slot] = p;
        forks.push(slot);
      }
    }

    // 被本 commit 消耗的合流列置空
    for (const j of merges) lanes[j] = null;
    // 清理尾部空列，减少无谓列宽
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    rows.push({
      col,
      lanesBefore: before,
      lanesAfter: lanes.slice(),
      merges,
      forks,
      isMerge: parents.length > 1,
    });
  }
  return rows;
}
