/**
 * T19: the env lifecycle — phase derivation, wording, and the persisted record.
 *
 * Two properties matter here and neither is visible from a screenshot:
 *   · the phase is DERIVED from live facts, so a reload (or a run in flight)
 *     can never show a stale "ready"/"待准备";
 *   · the ONE thing that must survive a reload — the user's consent — is stored
 *     in a record whose round-trip (and its legacy-key fallback) is asserted.
 */
import * as assert from 'node:assert';
import {
  ENV_CONSENT_KEY,
  ENV_PHASE_KEY,
  EnvPhase,
  MementoLike,
  clearEnvPhaseRecord,
  deriveEnvPhase,
  envPhaseHtml,
  envPhaseView,
  isConsented,
  phaseBadgeText,
  phaseLine,
  readEnvPhaseRecord,
  withConsent,
  withPhase,
  writeEnvPhaseRecord,
} from '../core/envPhase';

/** A `MementoLike` over a Map (what `globalState` behaves like for our subset). */
function fakeMemento(initial: Record<string, unknown> = {}): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

const base = {
  laneAvailable: true,
  laneReady: false,
  consented: false,
};

describe('T19 envPhase (one lifecycle for three lanes)', () => {
  it('derives the five phases with a documented precedence (facts beat records)', () => {
    const cases: Array<[string, Parameters<typeof deriveEnvPhase>[0], EnvPhase]> = [
      ['probes not finished → detecting (we know nothing yet)', { ...base, probed: false }, 'detecting'],
      ['a run in flight → provisioning (never a stale ready)', { ...base, consented: true, provisioning: true, laneReady: true }, 'provisioning'],
      ['the lane is ready → ready (even if a failure was recorded)', { ...base, laneReady: true, error: '上次失败' }, 'ready'],
      ['a manual prerequisite → blocked (consent cannot buy it)', { ...base, consented: true, guide: 'xcode-select --install' }, 'blocked'],
      ['a recorded failure → blocked with its reason', { ...base, consented: true, error: 'apt 失败' }, 'blocked'],
      ['no managed lane on this host → blocked', { ...base, laneAvailable: false }, 'blocked'],
      ['lane available, no consent → needsConsent', { ...base }, 'needsConsent'],
      ['lane available, consented, not ready → still waits for the user', { ...base, consented: true }, 'needsConsent'],
    ];
    for (const [why, facts, expected] of cases) {
      assert.strictEqual(deriveEnvPhase(facts), expected, why);
    }
  });

  it('every phase has ONE wording + the action the user needs (and none while busy)', () => {
    const detecting = envPhaseView({ ...base, probed: false });
    assert.strictEqual(detecting.label, '检测中');
    assert.strictEqual(detecting.action, undefined, 'nothing to press while detecting');

    const ask = envPhaseView({ ...base });
    assert.strictEqual(ask.label, '待你确认');
    assert.deepStrictEqual(ask.action, { id: 'env:prepare', label: '同意并准备' });

    const consented = envPhaseView({ ...base, consented: true });
    assert.strictEqual(consented.label, '待准备', '已同意与会话内首次询问必须可区分');
    assert.strictEqual(consented.action?.label, '一键准备环境');

    const running = envPhaseView({ ...base, consented: true, provisioning: true });
    assert.strictEqual(running.label, '准备中');
    assert.strictEqual(running.action, undefined, '准备中不能再给按钮（会重复触发）');

    const ready = envPhaseView({ ...base, laneReady: true });
    assert.strictEqual(ready.label, '已就绪');
    assert.strictEqual(ready.tone, 'ok');

    const blockedGuide = envPhaseView({ ...base, guide: 'xcode-select --install' });
    assert.strictEqual(blockedGuide.tone, 'fail');
    assert.match(blockedGuide.note ?? '', /xcode-select/u, '受阻必须把原因/指引原样带出');
    assert.strictEqual(blockedGuide.action?.label, '按指引完成前置');

    const blockedError = envPhaseView({ ...base, error: 'apt-get install lcov 失败' });
    assert.match(blockedError.note ?? '', /apt-get install lcov/u);
    assert.strictEqual(blockedError.action?.label, '重试准备', '有报错时是重试，不是"按指引"');

    const noLane = envPhaseView({ ...base, laneAvailable: false });
    assert.match(noLane.note ?? '', /本机工具链/u, '没有车道必须给出 system 出口');
    assert.match(phaseLine(noLane), /^blocked /u);
    assert.strictEqual(phaseBadgeText(blockedGuide), '! 受阻');
  });

  it('renders a strip that carries the phase itself (data-env-phase) + the action', () => {
    assert.strictEqual(envPhaseHtml(null), '', 'no phase → no strip');
    assert.strictEqual(envPhaseHtml(undefined), '');
    assert.ok(envPhaseHtml(envPhaseView({ ...base, probed: false })).includes('data-env-phase="detecting"'));
    const running = envPhaseHtml(envPhaseView({ ...base, consented: true, provisioning: true }));
    assert.ok(running.includes('data-env-phase="provisioning"'));
    assert.ok(!running.includes('data-page-action='), '准备中不得渲染可点动作');
    const ask = envPhaseHtml(envPhaseView({ ...base }));
    assert.ok(ask.includes('data-page-action="env:prepare"'));
    assert.ok(ask.includes('待你确认'));
  });

  it('persists the phase + consent and survives a reload (round trip)', async () => {
    const m = fakeMemento();
    assert.strictEqual(readEnvPhaseRecord(m).phase, 'detecting', 'nothing stored → 检测中');
    assert.strictEqual(isConsented(m), false);

    await writeEnvPhaseRecord(m, withPhase(withConsent(readEnvPhaseRecord(m), 111), 'provisioning', 222, { lane: 'linux-managed' }));
    const rec = readEnvPhaseRecord(m);
    assert.strictEqual(rec.phase, 'provisioning');
    assert.strictEqual(rec.consentedAt, 111);
    assert.strictEqual(rec.lane, 'linux-managed');
    assert.strictEqual(isConsented(m), true, 'consent survives the reload');
    assert.strictEqual(rec.at, 222);

    // A successful run clears the failure reason; a failure records it.
    await writeEnvPhaseRecord(m, withPhase(rec, 'blocked', 333, { reason: 'root apt 失败' }));
    assert.strictEqual(readEnvPhaseRecord(m).reason, 'root apt 失败');
    await writeEnvPhaseRecord(m, withPhase(readEnvPhaseRecord(m), 'provisioning', 444, { lane: 'linux-managed' }));
    assert.strictEqual(readEnvPhaseRecord(m).reason, undefined, '准备中必须清掉上一次的失败原因');
    await writeEnvPhaseRecord(m, withPhase(readEnvPhaseRecord(m), 'ready', 555));
    const ready = readEnvPhaseRecord(m);
    assert.strictEqual(ready.phase, 'ready');
    assert.strictEqual(ready.consentedAt, 111, '终态也不能丢掉同意记录');

    // withConsent is idempotent (never re-asks, never rewrites the timestamp).
    assert.strictEqual(withConsent(ready, 999).consentedAt, 111);
  });

  it('tolerates garbage and honours the legacy consent flag (no upgrade re-ask)', () => {
    assert.strictEqual(readEnvPhaseRecord(fakeMemento({ [ENV_PHASE_KEY]: 'ready' })).phase, 'detecting', '老形状/坏值 → 安全默认');
    assert.strictEqual(readEnvPhaseRecord(fakeMemento({ [ENV_PHASE_KEY]: { phase: 'nope' } })).phase, 'detecting');
    assert.strictEqual(readEnvPhaseRecord(fakeMemento({ [ENV_PHASE_KEY]: { phase: 'blocked', at: 'x', reason: '' } })).at, 0);
    // Legacy: `het.env.consented === true` from an older version still counts.
    assert.strictEqual(isConsented(fakeMemento({ [ENV_CONSENT_KEY]: true })), true);
    assert.strictEqual(isConsented(fakeMemento({ [ENV_CONSENT_KEY]: false })), false);
  });

  it('removing the managed env forgets the lifecycle (both keys), so we ask again next time', async () => {
    const m = fakeMemento({ [ENV_CONSENT_KEY]: true });
    await writeEnvPhaseRecord(m, withPhase(withConsent(readEnvPhaseRecord(m), 1), 'ready', 2));
    await clearEnvPhaseRecord(m);
    assert.strictEqual(m.store.get(ENV_PHASE_KEY), undefined);
    assert.strictEqual(isConsented(m), false, '移除后必须重新询问（旧布尔键也要清）');
    assert.strictEqual(readEnvPhaseRecord(m).phase, 'detecting');
  });
});
