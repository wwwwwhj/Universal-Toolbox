import { GitBranch } from "lucide-react";

export default function GitPage() {
  return (
    <section className="ui-empty">
      <div className="ui-empty-icon"><GitBranch size={22} aria-hidden="true" /></div>
      <h1>Git 管理</h1>
      <p>模块已就绪，仓库管理功能尚未实现。</p>
    </section>
  );
}
