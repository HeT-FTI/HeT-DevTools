/**
 * 页内「输出」视图（D 块）：**唯一的输出通道**在页面里的一个窗口 ——
 * 不离开当前页就能按 **域 / 级别 / 关键字** 过滤那一段日志。
 *
 * 为什么要在页面里再看一遍（而不是"去 Output 面板看"）：长构建失败时用户的动作是
 * "我要只看 build 的 ✗ 那几行"，去 Output 面板还得先选中通道、再肉眼翻 —— 这里一次点选就够。
 *
 * 纯函数（不 import vscode）：过滤逻辑在 `core/outputLog.ts`，这里只负责 HTML。
 */
import { esc } from '../ui';
import { LOG_DOMAINS, LOG_LEVELS, type LogEntry, type LogDomain, type LogLevel } from '../../core/outputChannels';

/** 过滤条件（与 `LogFilter` 同形；页面发回来的就是这个）。 */
export interface OutputFilterState {
  domain: LogDomain | '';
  level: LogLevel | '';
  keyword: string;
}

export const EMPTY_FILTER: OutputFilterState = { domain: '', level: '', keyword: '' };

/** 级别 → 中文（页面上用中文，行里保留符号：两者同源，见 LOG_LEVELS）。 */
const LEVEL_LABEL: Readonly<Record<LogLevel, string>> = {
  step: '开始',
  ok: '成功',
  fail: '失败',
  warn: '警告',
  timeout: '超时',
  cancel: '已取消',
  info: '信息',
};

const DOMAIN_LABEL: Readonly<Record<string, string>> = {
  build: '构建验证',
  test: '全量测试',
  docs: '模块文档',
  env: '环境车道',
  quality: '质量安全',
  release: '交付发布',
  chat: 'Copilot',
};

export function domainLabel(domain: LogDomain): string {
  return DOMAIN_LABEL[domain] ?? domain;
}

/** 一行（域名 + 级别 + 时间 + 文本；等宽，便于对齐） */
function rowHtml(e: LogEntry): string {
  const time = new Date(e.at).toTimeString().slice(0, 8);
  return (
    `<div class="out-row lv-${esc(e.level)}" data-domain="${esc(e.domain)}">` +
    `<span class="out-t">${esc(time)}</span>` +
    `<span class="out-d">${esc(domainLabel(e.domain))}</span>` +
    `<span class="out-l">${esc(LEVEL_LABEL[e.level])}</span>` +
    `<span class="out-x">${esc(e.text)}</span>` +
    `</div>`
  );
}

/**
 * 视图正文（纯函数，可单测）。
 *
 * 三个过滤控件 + 计数 + 行列表；**没有"再开一个通道"这类入口**（C4：输出只有一个出处）。
 */
export function outputViewHtml(entries: readonly LogEntry[], filter: OutputFilterState): string {
  const domainOpts = ['<option value="">全部域</option>']
    .concat(
      LOG_DOMAINS.map(
        (d) =>
          `<option value="${esc(d)}"${filter.domain === d ? ' selected' : ''}>${esc(domainLabel(d))}</option>`,
      ),
    )
    .join('');
  const levelOpts = ['<option value="">全部级别</option>']
    .concat(
      LOG_LEVELS.map(
        (l) => `<option value="${esc(l)}"${filter.level === l ? ' selected' : ''}>${esc(LEVEL_LABEL[l])}</option>`,
      ),
    )
    .join('');
  const rows = entries.length
    ? entries.map(rowHtml).join('')
    : '<div class="out-empty">没有匹配的行（换个域/级别，或先跑一次动作）</div>';
  return `<div class="out">
  <div class="out-bar">
    <select class="out-sel" data-out="domain" aria-label="按域过滤">${domainOpts}</select>
    <select class="out-sel" data-out="level" aria-label="按级别过滤">${levelOpts}</select>
    <input class="out-kw" data-out="keyword" type="search" placeholder="关键字（大小写不敏感）" value="${esc(filter.keyword)}" aria-label="按关键字过滤" />
    <button class="secondary" data-act="outputClear">清空条件</button>
    <span class="out-count" data-out-count>${entries.length} 行</span>
  </div>
  <div class="out-list">${rows}</div>
</div>`;
}
