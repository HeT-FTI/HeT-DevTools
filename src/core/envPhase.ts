/**
 * T19: the environment LIFECYCLE — one model for all three lanes.
 *
 *   detecting → needsConsent → provisioning → ready
 *                                   ↘         ↗
 *                                     blocked
 *
 * Why a model instead of the previous ad-hoc booleans: consent used to be a
 * bare `het.env.consented` flag, "正在准备" lived only in a toast, and the card
 * re-derived everything from probe values, so a reload lost the fact that the
 * user had already agreed, and a failed prepare looked exactly like a machine
 * that had never been touched. Three platforms therefore told three different
 * stories about the same five situations.
 *
 * Split of responsibilities (kept deliberately small):
 *   · `deriveEnvPhase` is LIVE — it reads the current facts (lane available?
 *     ready? consent recorded? run in flight? last error?) and returns the
 *     phase, so the UI can never show a stale phase;
 *   · the PERSISTED record only carries the user's DECISION (`consentedAt`) and
 *     the last outcome/reason — the two things that cannot be re-probed.
 *
 * Pure (no vscode/fs): persistence goes through the `MementoLike` shape, which
 * is what `ExtensionContext.globalState` already satisfies.
 */

export type EnvPhase = 'detecting' | 'needsConsent' | 'provisioning' | 'ready' | 'blocked';

export const ENV_PHASES: readonly EnvPhase[] = ['detecting', 'needsConsent', 'provisioning', 'ready', 'blocked'];

/** Tone for the card strip (CSS class + icon). */
export type EnvPhaseTone = 'ok' | 'warn' | 'fail' | 'wait';

export interface EnvPhaseFacts {
  /** A managed lane exists for this host (managed provider decided). */
  laneAvailable: boolean;
  /** The lane is bootstrapped (probe / managed marker says ready). */
  laneReady: boolean;
  /** The user agreed once (this session or a recorded earlier session). */
  consented: boolean;
  /** A prepare run is in flight right now. */
  provisioning?: boolean;
  /** A manual prerequisite the user must do first (CLI text; '' = none). */
  guide?: string;
  /** Last prepare failure ('' = none). */
  error?: string;
  /** Read-only probes finished for this payload (`false` → 检测中). */
  probed?: boolean;
}

export interface EnvPhaseView {
  phase: EnvPhase;
  /** Short zh label for the strip. */
  label: string;
  tone: EnvPhaseTone;
  /** Next user action (only when the phase waits for one). */
  action?: { id: string; label: string };
  /** Honest one-liner: what is missing / why it is blocked. */
  note?: string;
}

/**
 * Derive the live phase. Precedence matters and is the contract:
 *   1. probes not finished           → detecting (we know nothing yet)
 *   2. a run is in flight            → provisioning (never a stale "ready")
 *   3. the lane is ready             → ready (facts win over a recorded error)
 *   4. blocked (guide/error/no lane) → blocked — always with a reason
 *   5. consent not recorded          → needsConsent
 *   6. otherwise                     → needsConsent (consented, waiting for the
 *      user to actually press prepare; the label distinguishes the two)
 */
export function deriveEnvPhase(f: EnvPhaseFacts): EnvPhase {
  if (f.probed === false) {
    return 'detecting';
  }
  if (f.provisioning === true) {
    return 'provisioning';
  }
  if (f.laneReady) {
    return 'ready';
  }
  if (f.guide || f.error || !f.laneAvailable) {
    return 'blocked';
  }
  return 'needsConsent';
}

const ICON: Record<EnvPhase, string> = { detecting: '⟳', needsConsent: '?', provisioning: '⟳', ready: '✓', blocked: '!' };

/** The strip view for a phase (label/tone/action/note) — one wording per phase. */
export function envPhaseView(f: EnvPhaseFacts): EnvPhaseView {
  const phase = deriveEnvPhase(f);
  switch (phase) {
    case 'detecting':
      return { phase, label: '检测中', tone: 'wait', note: '正在读取主机能力与车道事实…' };
    case 'provisioning':
      return { phase, label: '准备中', tone: 'wait', note: '正在车道内准备 conan/cmake/ninja（首次较慢，之后是秒级检查）。' };
    case 'ready':
      return { phase, label: '已就绪', tone: 'ok' };
    case 'blocked':
      return {
        phase,
        label: '受阻',
        tone: 'fail',
        action: f.guide && !f.error ? { id: 'env:prepare', label: '按指引完成前置' } : { id: 'env:prepare', label: '重试准备' },
        note: f.error || f.guide || '当前主机没有可用的托管车道：可用"改用本机工具链"（system · 兼容模式）。',
      };
    default:
      return {
        phase: 'needsConsent',
        label: f.consented ? '待准备' : '待你确认',
        tone: 'warn',
        action: { id: 'env:prepare', label: f.consented ? '一键准备环境' : '同意并准备' },
        note: f.consented ? '已授权；按下按钮即在车道内准备工具链。' : '将在隔离车道内下载 conan/cmake/ninja，必要时用免密 root 安装编译器/lcov。',
      };
  }
}

/** Icon + label, e.g. `✓ 已就绪` (used by the strip and the dump). */
export function phaseBadgeText(view: EnvPhaseView): string {
  return `${ICON[view.phase]} ${view.label}`;
}

/** One-line status for logs/dumps: `ready ✓ · <note>`. */
export function phaseLine(view: EnvPhaseView): string {
  return `${view.phase} ${ICON[view.phase]}${view.note ? ` · ${view.note}` : ''}`;
}

/**
 * Card strip (pure). Kept separate from `envCardHtml` so a payload without a
 * contract (fallback blocks) still shows the lifecycle honestly.
 */
export function envPhaseHtml(view?: EnvPhaseView | null): string {
  if (!view) {
    return '';
  }
  const esc = (s: string): string => s.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  const action = view.action
    ? `<button class="textbtn" data-page-action="${esc(view.action.id)}">${esc(view.action.label)}</button>`
    : '';
  return (
    `<div class="env" data-env-phase="${esc(view.phase)}">` +
    `<div class="drow"><span class="dk">${esc(phaseBadgeText(view))} 环境状态</span>` +
    `<span class="dv dim">${esc(view.note ?? '')}</span><span class="dv">${action}</span></div></div>`
  );
}

/* -------------------------------------------------------------------------- *
 * Persistence (the only thing that must survive a reload)
 * -------------------------------------------------------------------------- */

/** Current key: the whole lifecycle record. */
export const ENV_PHASE_KEY = 'het.env.phase';
/** Legacy key (a bare boolean). Still READ so an upgrade does not re-ask. */
export const ENV_CONSENT_KEY = 'het.env.consented';

export interface EnvPhaseRecord {
  /** Last known phase (live derivation wins for display; this is the record). */
  phase: EnvPhase;
  /** Epoch ms of the last write. */
  at: number;
  /** Provider/lane id the record refers to (avoid mixing platforms). */
  lane?: string;
  /** Reason of the last `blocked` (cleared by a successful run). */
  reason?: string;
  /** Epoch ms of the user's consent — the ONE thing we must not lose. */
  consentedAt?: number;
}

/** The subset of `vscode.Memento` used here (injectable for tests). */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<unknown> | void;
}

const DEFAULT_RECORD: EnvPhaseRecord = { phase: 'detecting', at: 0 };

const isPhase = (v: unknown): v is EnvPhase => typeof v === 'string' && (ENV_PHASES as readonly string[]).includes(v);

/** Tolerant read: garbage, a legacy shape or nothing at all → sane defaults. */
export function readEnvPhaseRecord(m: MementoLike): EnvPhaseRecord {
  const raw = m.get<Partial<EnvPhaseRecord>>(ENV_PHASE_KEY);
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_RECORD };
  }
  const out: EnvPhaseRecord = {
    phase: isPhase(raw.phase) ? raw.phase : 'detecting',
    at: typeof raw.at === 'number' ? raw.at : 0,
  };
  if (typeof raw.lane === 'string' && raw.lane) {
    out.lane = raw.lane;
  }
  if (typeof raw.reason === 'string' && raw.reason) {
    out.reason = raw.reason;
  }
  if (typeof raw.consentedAt === 'number' && raw.consentedAt > 0) {
    out.consentedAt = raw.consentedAt;
  }
  return out;
}

export async function writeEnvPhaseRecord(m: MementoLike, record: EnvPhaseRecord): Promise<void> {
  await m.update(ENV_PHASE_KEY, record);
}

/** Forget the lifecycle (「移除托管环境」/ uninstall semantics). */
export async function clearEnvPhaseRecord(m: MementoLike): Promise<void> {
  await m.update(ENV_PHASE_KEY, undefined);
  await m.update(ENV_CONSENT_KEY, false);
}

/** Has the user already agreed on this machine? (new record, then legacy key) */
export function isConsented(m: MementoLike): boolean {
  if (readEnvPhaseRecord(m).consentedAt !== undefined) {
    return true;
  }
  return m.get<boolean>(ENV_CONSENT_KEY) === true;
}

/** Record the consent (idempotent) and keep it in the lifecycle record. */
export function withConsent(record: EnvPhaseRecord, at: number): EnvPhaseRecord {
  if (record.consentedAt !== undefined) {
    return record;
  }
  return { ...record, consentedAt: at, at };
}

/** Transition helper: a new phase + optional lane/reason, keeping the consent. */
export function withPhase(
  record: EnvPhaseRecord,
  phase: EnvPhase,
  at: number,
  extra: { lane?: string; reason?: string } = {},
): EnvPhaseRecord {
  const next: EnvPhaseRecord = { ...record, phase, at };
  if (extra.lane) {
    next.lane = extra.lane;
  }
  // A successful run clears the previous failure; `ready` never carries a reason.
  if (extra.reason) {
    next.reason = extra.reason;
  } else if (phase === 'ready' || phase === 'provisioning') {
    delete next.reason;
  }
  return next;
}
