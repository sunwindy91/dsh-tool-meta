// 协调层（L5）：共享任务板 + CAS —— 防互踩的轻量实现。
// 官方哲学（agent-team 一手原则）：不用文件锁（会掩盖并发边界），用共享状态机
// （任务板 revision CAS + 冲突交用户 review）。本板为进程内单例 MVP。
class Board {
  constructor() {
    this.revision = 0;
    this.claims = []; // { path, owner, ts }
  }

  /** 声明写入域（disjoint scopes）：重叠 → 冲突拒绝（交用户 review，不静默覆盖） */
  claim(path, owner) {
    const overlap = this.claims.find((c) => c.path === path);
    if (overlap) {
      return {
        ok: false,
        error: `写入域冲突：${path} 已被 ${overlap.owner} 声明（disjoint scopes 原则——请协商分工或等其 release）`,
        conflict: overlap,
        revision: this.revision,
      };
    }
    this.claims.push({ path, owner, ts: Date.now() });
    this.revision += 1;
    return { ok: true, revision: this.revision, entry: { path, owner }, claims: this.list() };
  }

  /** 释放写入域（写完后归还） */
  release(path, owner) {
    const idx = this.claims.findIndex((c) => c.path === path && c.owner === owner);
    if (idx < 0) return { ok: false, error: `未找到 ${path} 的声明（owner=${owner}）` };
    this.claims.splice(idx, 1);
    this.revision += 1;
    return { ok: true, revision: this.revision, claims: this.list() };
  }

  /** 任务板快照（谁声明了什么，单一事实源） */
  list() {
    return { revision: this.revision, entries: this.claims.map((c) => ({ ...c })) };
  }
}

export const board = new Board();
