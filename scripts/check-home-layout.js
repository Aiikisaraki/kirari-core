#!/usr/bin/env node
// scripts/check-home-layout.js
// 校验核心版与桌宠版的「数据根布局」是否逐字一致。
//
// 为什么需要这条检查：kirari-core（pet-api）和 kirari-desktop（akisaki-kirari）
// 读写的是**同一份数据**（同一个 config.json、同一个 pet_sessions.db、同一套皮肤）。
// 两边的 LAYOUT 一旦漂移，就会一边写 A 一边读 B —— 数据分叉，且极难发现
// （表现是「配置改了不生效」「历史少了一半」）。
//
// 用法：
//   node scripts/check-home-layout.js                 # 用默认的同级仓库路径
//   node scripts/check-home-layout.js --desktop <dir> # 指定桌宠仓库路径
//
// 退出码：0 = 一致；1 = 漂移（CI 可直接用）。
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--desktop' && argv[i + 1]) out.desktop = argv[++i];
        else if (a === '--json') out.json = true;
    }
    return out;
}

/** 从 TS 源码里抽出 LAYOUT（支持值是字面量或同文件常量引用）。 */
function parseDesktopLayout(tsSrc) {
    const start = tsSrc.indexOf('export const LAYOUT = {');
    const end = tsSrc.indexOf('} as const;', start);
    if (start < 0 || end < 0) throw new Error('未在 kirari-home.ts 里找到 LAYOUT 定义');
    const block = tsSrc.slice(start, end);

    const consts = {};
    for (const m of tsSrc.matchAll(/^const\s+(\w+)\s*=\s*"([^"]+)";\s*$/gm)) consts[m[1]] = m[2];

    const layout = {};
    for (const m of block.matchAll(/^\s*(\w+):\s*(?:"([^"]+)"|(\w+)),?\s*$/gm)) {
        const [, key, lit, ident] = m;
        if (lit !== undefined) layout[key] = lit;
        else if (ident && consts[ident] !== undefined) layout[key] = consts[ident];
        else layout[key] = `<无法解析:${ident}>`;
    }
    return layout;
}

function main() {
    const args = parseArgs(process.argv);
    const coreLayout = require('../src/kirariHome').LAYOUT;

    // 桌宠仓库默认与本仓库同级（D:\personal-proj\{pet-api,akisaki-kirari}）。
    // 历史上有过 pet-proj 中间层，那个结构已经废弃；这里保留旧路径作为候选，
    // 只是为了让还没改工作区的人跑得动，不是让它悄悄兜底 —— 全都找不到就明确报错。
    const candidates = args.desktop
        ? [args.desktop]
        : [
              path.resolve(__dirname, '..', '..', 'akisaki-kirari'),
              path.resolve(__dirname, '..', '..', 'pet-proj', 'akisaki-kirari'),
          ];
    let desktopDir = candidates[0];
    let tsFile = path.join(desktopDir, 'electron', 'kirari-home.ts');
    if (!args.desktop) {
        const found = candidates.find((d) => fs.existsSync(path.join(d, 'electron', 'kirari-home.ts')));
        if (found) {
            desktopDir = found;
            tsFile = path.join(desktopDir, 'electron', 'kirari-home.ts');
        }
    }
    if (!fs.existsSync(tsFile)) {
        console.error(`找不到桌宠版布局文件：${tsFile}`);
        console.error('已尝试的路径：');
        for (const c of candidates) console.error(`  - ${path.join(c, 'electron', 'kirari-home.ts')}`);
        console.error('用 --desktop <桌宠仓库路径> 指定。');
        process.exit(1);
    }
    const desktopLayout = parseDesktopLayout(fs.readFileSync(tsFile, 'utf-8'));

    const coreKeys = Object.keys(coreLayout).sort();
    const deskKeys = Object.keys(desktopLayout).sort();
    const onlyCore = coreKeys.filter((k) => !deskKeys.includes(k));
    const onlyDesk = deskKeys.filter((k) => !coreKeys.includes(k));
    const shared = coreKeys.filter((k) => deskKeys.includes(k));
    const mismatched = shared.filter((k) => coreLayout[k] !== desktopLayout[k]);

    const ok = !onlyCore.length && !onlyDesk.length && !mismatched.length;

    if (args.json) {
        console.log(JSON.stringify({ ok, onlyCore, onlyDesk, mismatched, shared: shared.length }, null, 2));
    } else {
        for (const k of shared.sort()) {
            const same = coreLayout[k] === desktopLayout[k];
            console.log(
                `${same ? '✅' : '❌'} ${k.padEnd(18)} core=${coreLayout[k].padEnd(32)} desktop=${desktopLayout[k]}`,
            );
        }
        if (onlyCore.length) console.log(`\n❌ 只在核心版：${onlyCore.join(', ')}`);
        if (onlyDesk.length) console.log(`\n❌ 只在桌宠版：${onlyDesk.join(', ')}`);
        if (mismatched.length) console.log(`\n❌ 路径不一致：${mismatched.join(', ')}`);
        console.log(
            ok
                ? `\n✅ 布局一致（${shared.length} 项）：两端读写同一份数据`
                : '\n❌ 布局漂移：两端会读写不同的文件，必须修正',
        );
    }
    process.exit(ok ? 0 : 1);
}

main();
