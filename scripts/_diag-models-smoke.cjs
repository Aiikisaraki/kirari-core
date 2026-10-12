// 一次性冒烟：核心版模型配置迁移到 data/config.json（与桌面端同构）。
// 跑法：C:/Program Files/nodejs/node.exe scripts/_diag-models-smoke.cjs
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}${extra ? ' —— ' + JSON.stringify(extra) : ''}`); }
}

function makeDataDir() {
    const base = path.join(process.cwd(), '.tmp-test');
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, 'models-'));
}

function loadDbStorage(dataDir) {
    process.env.PET_API_DATA_DIR = dataDir;
    delete require.cache[require.resolve('../src/db/dbStorage')];
    delete require.cache[require.resolve('../src/services/modelConfigFile')];
    return require('../src/db/dbStorage');
}

function readConfigFile(dataDir) {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8'));
}

/** 手工建一个「旧 SQLite 状态」：new-schema model_profiles + settings_kv + 全列 api_tokens */
function seedLegacyDb(dataDir, { profiles, activeId, tokenRow }) {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dataDir, 'pet_sessions.db'));
    db.exec(`CREATE TABLE model_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT, userid INTEGER NOT NULL, name TEXT NOT NULL,
        endpoint TEXT NOT NULL, model TEXT NOT NULL, "key" TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.exec(`CREATE TABLE settings_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.exec(`CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, userid INTEGER NOT NULL UNIQUE, token TEXT NOT NULL,
        view_password TEXT NOT NULL DEFAULT '', client_id TEXT, model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
        api_endpoint TEXT, search_key TEXT, search_endpoint TEXT, search_provider TEXT NOT NULL DEFAULT 'uapis')`);
    for (const p of profiles) {
        db.prepare('INSERT INTO model_profiles (userid, name, endpoint, model, "key") VALUES (1, ?, ?, ?, ?)')
            .run(p.name, p.endpoint, p.model, p.key);
    }
    if (activeId != null) {
        db.prepare("INSERT INTO settings_kv (key, value) VALUES ('active_model:1', ?)").run(String(activeId));
    }
    if (tokenRow) {
        db.prepare('INSERT INTO api_tokens (userid, token, model, api_endpoint, search_key, search_endpoint, search_provider) VALUES (1, ?, ?, ?, ?, ?, ?)')
            .run(tokenRow.key, tokenRow.model, tokenRow.endpoint, tokenRow.searchKey || null, tokenRow.searchEndpoint || null, tokenRow.searchProvider || 'uapis');
    }
    db.close();
}

async function main() {
    // ── 场景 1：全新部署 → 首次访问创建空 config.json，CRUD 走文件 ──
    console.log('\n[1] 全新部署：建文件 / 添加自动生效 / 列表形状');
    {
        const dir = makeDataDir();
        const store = loadDbStorage(dir);
        const id = await store.addModelProfile(1, { name: '便宜快档', endpoint: 'https://a.example/v1/', model: 'm-a', key: 'sk-aaa-1234567890' });
        check('添加返回 id=1', id === 1);
        check('第一套自动成为当前', store.getActiveModelId(1) === 1);
        check('config.json 已创建', fs.existsSync(path.join(dir, 'config.json')));
        const list = await store.listModelProfiles(1);
        check('列表形状 camel + 掩码', list.items[0].endpoint === 'https://a.example/v1/' && list.items[0].keyMasked === 'sk-******7890' && list.items[0].hasKey === true && list.activeId === 1, list);
        check('列表不泄明文', !JSON.stringify(list).includes('sk-aaa-1234567890'));
        const ac = await store.getActiveModelConfig(1);
        check('聊天取配置来自文件套', ac.model === 'm-a' && ac.endpoint === 'https://a.example/v1/' && ac.key === 'sk-aaa-1234567890' && ac.source === 'model#1(便宜快档)', ac);
        // 第二套不动顶层
        await store.addModelProfile(1, { name: 'B', endpoint: 'https://b.example/v1', model: 'm-b', key: 'sk-bbb' });
        const cfg = readConfigFile(dir);
        check('添加第二套不动顶层', cfg.endpoint === 'https://a.example/v1/' && cfg.activeModelId === 1 && cfg.models.length === 2);
    }

    // ── 场景 2：SQLite 里已有多模型数据 → 首次启动整表迁进文件 ──
    console.log('\n[2] SQLite 多模型数据 → config.json 整表迁移');
    {
        const dir = makeDataDir();
        seedLegacyDb(dir, {
            profiles: [
                { name: 'A', endpoint: 'https://a/v1', model: 'm-a', key: 'sk-a-111' },
                { name: 'B', endpoint: 'https://b/v1', model: 'm-b', key: 'sk-b-222' },
            ],
            activeId: 2,
        });
        const store = loadDbStorage(dir);
        const list = await store.listModelProfiles(1);
        check('两套都迁进文件', list.items.length === 2 && list.items[1].name === 'B' && list.activeId === 2, list);
        const cfg = readConfigFile(dir);
        check('顶层同步成当前套的值', cfg.endpoint === 'https://b/v1' && cfg.key === 'sk-b-222');
        check('明文只落文件、不出现在列表', cfg.models[0].key === 'sk-a-111' && !JSON.stringify(list).includes('sk-a-111'));
    }

    // ── 场景 3：旧单套 api_tokens（三件套齐全）→ 导成「默认」套 + 搜索配置迁移 ──
    console.log('\n[3] 旧单套配置迁移 + getProfile 形状 + 搜索');
    {
        const dir = makeDataDir();
        seedLegacyDb(dir, {
            profiles: [],
            activeId: null,
            tokenRow: { key: 'sk-legacy-9999', model: 'm-legacy', endpoint: 'https://legacy.example/v1', searchKey: 'sk-search-1', searchEndpoint: 'http://192.168.57.5:8888', searchProvider: 'searxng' },
        });
        const store = loadDbStorage(dir);
        const p = await store.getProfile(1);
        check('getProfile 形状 camel（文件快照）', p.model === 'm-legacy' && p.endpoint === 'https://legacy.example/v1' && p.hasKey === true && p.searchProvider === 'searxng' && p.searchEndpoint === 'http://192.168.57.5:8888', p);
        const list = await store.listModelProfiles(1);
        check('导出「默认」套且设为当前', list.items.length === 1 && list.items[0].name === '默认' && list.activeId === 1);
        const sc = store.getSearchConfig(1);
        check('搜索配置迁进文件且明文可读', sc.searchProvider === 'searxng' && sc.searchKey === 'sk-search-1', sc);
        // setProfile 写搜索 → 文件
        await store.setProfile(1, { searchProvider: 'tavily', searchKey: 'sk-tv-2' });
        const sc2 = store.getSearchConfig(1);
        check('setProfile 写文件生效', sc2.searchProvider === 'tavily' && sc2.searchKey === 'sk-tv-2' && readConfigFile(dir).searchProvider === 'tavily');
    }

    // ── 场景 4：半配置旧档案（有密钥没地址）→ 不造套、如实空地址、聊天报错指路 ──
    console.log('\n[4] 半配置旧档案：不迁移、不套默认地址');
    {
        const dir = makeDataDir();
        seedLegacyDb(dir, {
            profiles: [],
            activeId: null,
            tokenRow: { key: 'sk-half-7777', model: 'm-half', endpoint: '' },
        });
        const store = loadDbStorage(dir);
        const p = await store.getProfile(1);
        check('顶层 endpoint 如实为空串', p.endpoint === '');
        const list = await store.listModelProfiles(1);
        check('不造半残的模型套', list.items.length === 0 && list.activeId === null, list);
        const ac = await store.getActiveModelConfig(1);
        check('生效配置如实空地址', ac.endpoint === '' && ac.model === 'm-half' && ac.key === 'sk-half-7777', ac);
        let msg = '';
        try {
            if (!ac.key || !ac.endpoint) throw new Error('还没配置大脑：先去控制台「大脑」里添加一套（服务地址 + 型号 + 钥匙）并设为当前');
        } catch (e) { msg = e.message; }
        check('聊天入口大白话报错', msg.includes('还没配置大脑'));
    }

    // ── 场景 4b：旧版 .env 的 MODEL_API_ENDPOINT → 一次性吸收进 config.json ──
    console.log('\n[4b] 旧 env 模型地址（DB 没写地址时）一次性吸收');
    {
        const dir = makeDataDir();
        seedLegacyDb(dir, {
            profiles: [],
            activeId: null,
            tokenRow: { key: 'sk-env-6666', model: 'm-env', endpoint: '' }, // DB 没写地址
        });
        process.env.MODEL_API_ENDPOINT = 'https://from-old-env.example/v1'; // 模拟旧版 .env
        const store = loadDbStorage(dir);
        await store.getProfile(1); // 首次访问触发迁移
        delete process.env.MODEL_API_ENDPOINT; // 吸收后即使删掉 env 也不影响（已落文件）
        const cfg = readConfigFile(dir);
        check('env 地址被吸进顶层', cfg.endpoint === 'https://from-old-env.example/v1' && cfg.key === 'sk-env-6666', cfg);
        const list = await store.listModelProfiles(1);
        check('导出「默认」套且地址正确', list.items.length === 1 && list.items[0].endpoint === 'https://from-old-env.example/v1');
        // 对照：DB 里写了地址时 env 不参与（场景 3 已覆盖 endpoint 用 DB 值）
    }

    // ── 场景 5：编辑/切换/删除语义（与桌面端一致）──
    console.log('\n[5] 编辑钥匙留空不改 / 切换覆盖顶层 / 删当前套置空 activeId');
    {
        const dir = makeDataDir();
        const store = loadDbStorage(dir);
        await store.addModelProfile(1, { name: 'A', endpoint: 'https://a/v1', model: 'm-a', key: 'sk-a-1111' });
        await store.addModelProfile(1, { name: 'B', endpoint: 'https://b/v1', model: 'm-b', key: 'sk-b-2222' });
        // 编辑留空不改
        await store.updateModelProfile(1, 1, { name: '改名', key: '' });
        let cfg = readConfigFile(dir);
        check('钥匙留空=不改', cfg.models[0].key === 'sk-a-1111' && cfg.models[0].name === '改名');
        // 切换覆盖顶层
        await store.setActiveModelId(1, 2);
        cfg = readConfigFile(dir);
        check('切换覆盖顶层 + 记 activeId', cfg.endpoint === 'https://b/v1' && cfg.activeModelId === 2);
        // 删当前套：activeId 置空、顶层不动
        await store.deleteModelProfile(1, 2);
        cfg = readConfigFile(dir);
        check('删当前套 activeId 置空、顶层不动', cfg.activeModelId === undefined && cfg.endpoint === 'https://b/v1' && cfg.models.length === 1);
        const ac = await store.getActiveModelConfig(1);
        check('删后聊天仍用顶层（还能聊）', ac.endpoint === 'https://b/v1' && ac.key === 'sk-b-2222');
    }

    // ── 场景 6：外部手改 config.json → 读到新值（监听回调路径）──
    console.log('\n[6] 外部手改 config.json 热生效');
    {
        const dir = makeDataDir();
        const store = loadDbStorage(dir);
        await store.addModelProfile(1, { name: 'A', endpoint: 'https://a/v1', model: 'm-a', key: 'sk-a-1111' });
        // 直接改文件（模拟外部编辑器）
        const cfg = readConfigFile(dir);
        cfg.models[0].model = 'm-a-edited';
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8');
        // 监听是异步去抖的；存储层每次读都基于内存 config，watch 回调负责刷新内存
        await new Promise((r) => setTimeout(r, 500));
        const list = await store.listModelProfiles(1);
        check('手改文件被监听到（内存已刷新）', list.items[0].model === 'm-a-edited', list);
    }

    // ── 场景 7：非控制台账号走 SQLite 旧路径，互不干扰 ──
    console.log('\n[7] 其他 uid 走旧 DB 路径，与文件互不干扰');
    {
        const dir = makeDataDir();
        const store = loadDbStorage(dir);
        await store.addModelProfile(1, { name: '文件套', endpoint: 'https://file/v1', model: 'm-file', key: 'sk-file' });
        await store.addModelProfile(2, { name: 'DB套', endpoint: 'https://db/v1', model: 'm-db', key: 'sk-db' });
        const file1 = await store.listModelProfiles(1);
        const db2 = await store.listModelProfiles(2);
        console.log('  [debug] uid2 列表 =', JSON.stringify(db2));
        check('uid1 走文件', file1.items.length === 1 && file1.items[0].name === '文件套');
        check('uid2 走 DB', db2.items.length === 1 && db2.items[0].name === 'DB套');
        const Database = require('better-sqlite3');
        const d2 = new Database(path.join(dir, 'pet_sessions.db'), { readonly: true });
        const n = d2.prepare('SELECT COUNT(*) AS n FROM model_profiles WHERE userid = 2').get().n;
        d2.close();
        check('uid2 的套落在 model_profiles 表', n === 1);
        check('文件里没有 uid2 的数据', readConfigFile(dir).models.length === 1);
    }

    console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
