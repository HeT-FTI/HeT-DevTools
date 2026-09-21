/**
 * Slot 标题（A 块收口）：**品牌名只出现在唯一页签上**，Slot 标题统一为 `<领域>：<对象>`。
 *
 * 依据 §5.1 的 rail 领域名（环境车道 / 构建验证 / 模块文档 / 质量安全 / 交付发布），
 * 以及 C9（每个可见入口都要能一句话说清用途）。原来 14 个视图的标题都是
 * `HeT DevTools — 中文名`：既是品牌前缀重复，也没有"这属于哪个领域"的信息。
 */
export const SLOT_TITLES: Readonly<Record<string, string>> = {
  health: '环境车道：环境体检',
  settings: '环境车道：项目设置',
  hud: '环境车道：快捷面板',
  deps: '构建验证：依赖管理器',
  coverage: '构建验证：覆盖率',
  testResults: '构建验证：测试结果',
  bench: '构建验证：上板测试',
  docs: '模块文档：文档中心',
  moduleWizard: '模块文档：新增模块向导',
  testgen: '模块文档：生成测试',
  quality: '质量安全：质量门禁',
  commit: '交付发布：提交助手',
  release: '交付发布：发布中心',
  preflight: '交付发布：发布前检查',
  ci: '交付发布：CI 状态',
};

/** 兜底：去掉品牌前缀（未登记的视图也不该把品牌名带进 Slot 标题）。 */
export function slotTitle(id: string, fallback: string): string {
  const known = SLOT_TITLES[id];
  if (known) {
    return known;
  }
  return fallback.replace(/^HeT\s*DevTools\s*[—–-]\s*/u, '').trim();
}
