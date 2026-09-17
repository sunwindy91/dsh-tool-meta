// 选择算子的"代表教训"选取：纯函数、零依赖、可单测。
// 为什么单独抽出来：宿主不告诉我们"这一轮到底加载了哪条 skill"，
// 所以"成功"只能作为**工具级**信号记在某一条上。既然只能记一条，选取就**必须确定性**，
// 否则同一个账本会因为目录顺序不同而给出不同结果（v0.4.4 修掉的真实缺陷）。
export function pickRepresentative(cands = []) {
  if (!Array.isArray(cands) || cands.length === 0) return null;
  return cands
    .slice()
    .sort(
      (a, b) =>
        (b.successes - a.successes) ||
        (b.trials - a.trials) ||
        String(a.created_at || "").localeCompare(String(b.created_at || "")),
    )[0];
}
