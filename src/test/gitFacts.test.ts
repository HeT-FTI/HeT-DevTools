/**
 * V3 · L4 / G3 门禁：**Git 事实**（分支 / 上游 / ahead-behind / 脏文件数）。
 *
 * 计划 §7.1 的验收原文：「夹具仓 ahead=2/脏 3 文件 → 事实正确；假数据 → 红」。
 * 所以这里**不止测解析字符串**：真起一个临时 git 仓（带裸仓当 origin），
 * 造出 ahead=2 + 3 个未跟踪文件，再用真命令的输出去喂 `parseStatusV2`
 * —— 这才是"事实来自真实 git 命令"的可测形式（纯造字符串的测试拦不住命令拼错）。
 */
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitFactOf, gitGateItem, parseStatusV2, receiptItem } from '../core/gitFacts';

/** 真 git 在不在（缺了就跳过，而不是给个假绿）。 */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 起一个夹具仓：裸仓当 origin，已推送 1 个提交；返回仓路径与"跑 git 命令"的函数。 */
function fixtureRepo(): { dir: string; git: (...args: string[]) => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'het-gitfacts-'));
  const bare = mkdtempSync(join(tmpdir(), 'het-gitfacts-remote-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'a.txt'), '1\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', bare);
  git('push', '-q', '-u', 'origin', 'HEAD');
  return {
    dir,
    git,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
    },
  };
}

describe('L4 · Git 事实（G3：分支/上游/领先落后/脏文件 一条命令拿全）', () => {
  it('解析 `git status --porcelain=v2 --branch`：分支 + 上游 + ab + 变更计数', () => {
    const out = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head feat/x',
      '# branch.upstream origin/main',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa bbb a.txt',
      '2 R. N... 100644 100644 100644 ccc ddd R100 t.txt\told.txt',
      '? new.txt',
      '# stash 1',
    ].join('\n');
    const f = parseStatusV2(out);
    assert.strictEqual(f.repo, true);
    assert.strictEqual(f.branch, 'feat/x');
    assert.strictEqual(f.upstream, 'origin/main');
    assert.strictEqual(f.ahead, 2);
    assert.strictEqual(f.behind, 3);
    assert.strictEqual(f.dirty, 3, '改动/重命名/未跟踪都算，头行与 stash 不算');
    assert.strictEqual(f.detached, false);
  });

  it('游离 HEAD 与"没有上游"是两件事（都不许当成"已同步"）', () => {
    const det = parseStatusV2('# branch.head (detached)\n# branch.oid abc\n');
    assert.strictEqual(det.detached, true);
    assert.strictEqual(det.branch, null);
    assert.strictEqual(gitFactOf(det).state, 'warn');
    assert.match(gitFactOf(det).next ?? '', /switch -c/u);

    const noUp = parseStatusV2('# branch.head feat/x\n');
    assert.strictEqual(noUp.upstream, null);
    assert.strictEqual(noUp.behind, 0);
    const view = gitFactOf(noUp);
    assert.strictEqual(view.state, 'idle', '本地分支 + 干净：不是红，只是"没得比"');
    assert.ok(view.fact.includes('本地分支'), view.fact);
    assert.ok(!view.fact.includes('同步'), `不许把"没上游"写成"已同步"：${view.fact}`);
  });

  it('一行文案：先说分支，再说"还差什么"，一次只给一个下一步', () => {
    const base = { repo: true, detached: false };
    const clean = gitFactOf({ ...base, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 0 });
    assert.strictEqual(clean.state, 'ok');
    assert.strictEqual(clean.fact, 'main · 工作区干净');
    assert.strictEqual(clean.next, undefined, '全绿不啰嗦');

    const dirty = gitFactOf({ ...base, branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: 3 });
    assert.strictEqual(dirty.state, 'warn');
    assert.strictEqual(dirty.fact, 'main · 3 个文件未提交');

    const ahead = gitFactOf({ ...base, branch: 'feat/x', upstream: 'origin/main', ahead: 2, behind: 0, dirty: 0 });
    assert.strictEqual(ahead.fact, 'feat/x · 工作区干净 · 领先 origin/main 2');
    assert.match(ahead.next ?? '', /git push/u);

    const behind = gitFactOf({ ...base, branch: 'feat/x', upstream: 'origin/main', ahead: 0, behind: 1, dirty: 0 });
    assert.match(behind.fact, /落后 origin\/main 1/u);
    assert.match(behind.next ?? '', /pull --rebase/u);

    // 脏 + 领先：一次只交代一件事（先提交，再推）
    const both = gitFactOf({ ...base, branch: 'feat/x', upstream: 'origin/main', ahead: 2, behind: 0, dirty: 3 });
    assert.match(both.next ?? '', /智能提交/u);
    assert.ok(!/git push/u.test(both.next ?? ''), '下一个动作只给一个：先提交');
  });

  it('**夹具仓实测**：ahead=2 / 3 个未提交 → 事实与门禁项都对', function () {
    if (!gitAvailable()) {
      this.skip();
    }
    const fx = fixtureRepo();
    try {
      const branch = fx.git('symbolic-ref', '--short', 'HEAD').trim();
      // 再提交两个（只在本地的）→ ahead=2
      for (const n of ['2', '3']) {
        writeFileSync(join(fx.dir, 'a.txt'), `${n}\n`);
        fx.git('add', '.');
        fx.git('commit', '-q', '-m', `local ${n}`);
      }
      // 三个未跟踪文件 → dirty=3
      for (const n of ['d1', 'd2', 'd3']) {
        writeFileSync(join(fx.dir, `${n}.txt`), 'x\n');
      }
      const facts = parseStatusV2(fx.git('status', '--porcelain=v2', '--branch'));
      assert.strictEqual(facts.repo, true);
      assert.strictEqual(facts.branch, branch);
      assert.strictEqual(facts.upstream, `origin/${branch}`, '上游就是它自己 push 出去的那条');
      assert.strictEqual(facts.ahead, 2, '真命令里的 ahead 必须是 2');
      assert.strictEqual(facts.behind, 0);
      assert.strictEqual(facts.dirty, 3, '真命令里的未提交数必须是 3');

      const view = gitFactOf(facts);
      assert.match(view.fact, new RegExp(`^${branch} · 3 个文件未提交`, 'u'));

      const gate = gitGateItem(facts);
      assert.strictEqual(gate.required, true);
      assert.strictEqual(gate.ok, false, '有未推提交 → 发布前检查必须红');
      assert.match(gate.detail, /未推 2/u);
      assert.match(gate.detail, /git push/u, '红项必须给可复制命令');

      // 清掉脏文件、只留未推的提交 → 仍然红（未推就是没闭环）
      fx.git('clean', '-q', '-fd');
      const after = parseStatusV2(fx.git('status', '--porcelain=v2', '--branch'));
      assert.strictEqual(after.dirty, 0);
      assert.strictEqual(gitGateItem(after).ok, false);

      // 推上去 → 变绿（门禁真的会翻面，不是恒红）
      fx.git('push', '-q', 'origin', 'HEAD');
      const pushed = parseStatusV2(fx.git('status', '--porcelain=v2', '--branch'));
      assert.strictEqual(pushed.ahead, 0);
      assert.strictEqual(gitGateItem(pushed).ok, true);
      assert.strictEqual(gitFactOf(pushed).state, 'ok');
    } finally {
      fx.cleanup();
    }
  });

  it('没有上游 / 没有仓：**不许**说"已推送"，只说"无法判断"', function () {
    if (!gitAvailable()) {
      this.skip();
    }
    const dir = mkdtempSync(join(tmpdir(), 'het-gitfacts-bare-'));
    try {
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'Test');
      writeFileSync(join(dir, 'x.txt'), '1\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      const noUp = parseStatusV2(git('status', '--porcelain=v2', '--branch'));
      assert.strictEqual(noUp.upstream, null);
      const gate = gitGateItem(noUp);
      assert.strictEqual(gate.ok, false, '本地分支没有上游 = 交付前必须处理');
      assert.match(gate.detail, /push -u origin/u, '必须给出照做就行的命令');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 根本不是仓：`repo:false` 时**不许**判红（未知 ≠ 失败）
    const noRepo = gitGateItem({ repo: false });
    assert.strictEqual(noRepo.ok, undefined);
    assert.strictEqual(noRepo.required, false);
    assert.match(noRepo.detail, /无法判断/u);
    assert.strictEqual(gitFactOf({ repo: false }).fact, '不是 git 仓库');
  });

  it('假数据 → 红：`receiptItem` 只认"CI 红 / PR 被关"两件真事', () => {
    const base = { ghPresent: true, hasRemote: true, branch: 'feat/x' };
    // 没查过 PR：不许写成"还没有 PR"（那是编造）
    const unchecked = receiptItem(base);
    assert.strictEqual(unchecked.ok, undefined);
    assert.match(unchecked.detail, /还没查过/u);
    assert.strictEqual(unchecked.required, false);

    // 查过了、确实没有
    assert.match(receiptItem({ ...base, pr: null }).detail, /还没有 PR/u);

    // CI 红 → 判红
    const red = receiptItem({ ...base, ci: 'fail', ciAt: '3 小时前' });
    assert.strictEqual(red.ok, false);
    assert.match(red.detail, /CI 上次 ✗/u);

    // PR 被关（没合）→ 判红
    const closed = receiptItem({ ...base, pr: { number: 12, state: 'CLOSED' }, ci: 'ok' });
    assert.strictEqual(closed.ok, false);
    assert.match(closed.detail, /PR #12 closed/u);

    // CI 绿 + PR 已合 → 唯一会判绿的组合
    const done = receiptItem({ ...base, pr: { number: 12, state: 'MERGED' }, ci: 'ok' });
    assert.strictEqual(done.ok, true);

    // 没有 gh：说清"为什么没取到"，而不是假装没事
    assert.match(receiptItem({ ghPresent: false, hasRemote: true }).detail, /没有 gh CLI/u);
    assert.match(receiptItem({ ghPresent: true, hasRemote: false }).detail, /没有 origin/u);
    assert.match(receiptItem({ ...base, prError: 'gh 退出码 403' }).detail, /403/u);
  });
});
