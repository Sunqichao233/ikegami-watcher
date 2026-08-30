// ==UserScript==
// @name         池上自動車教習所 — 空位监视
// @namespace    ikegami-watcher
// @version      1.4.0
// @description  在「次の週 / 前の週」之间往返导航，检测符合条件的空位并通知
// @match        https://www.e-license.jp/el32/pc/reserv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';
    // ══════════════════════════════════════════════════
    //  配置区 —— 改这里
    // ══════════════════════════════════════════════════

    const CFG = {
        // 往返跨度：2 = 在本周与下周之间来回；3 = 本周→+1→+2→回来，如此循环
        sweepWeeks: 2,

        // 每次导航的间隔（毫秒）。太短容易引起注意，建议 ≥ 30 秒
        intervalMs: 60_000,

        // 随机抖动 ±（毫秒），避免固定节奏
        jitterMs: 15_000,

        // ── 想要的时段：仅作「首次使用」的初始值 ──
        // 装好后请用面板上的 ⚙ 按钮可视化设置，配置存于 localStorage
        // 改动这里不会覆盖已保存的设置 —— 需在设置窗里点「重置为默认」

        // 平日（月〜金）只看这几限。11 = 19:00，12 = 20:00
        weekdayZigen: [11, 12],
        // 周末（土日）看哪几限。null = 全天
        weekendZigen: null,

        // 特定日期区间「全天监控」。格式 YYYYMMDD，含首尾
        fullDayRanges: [
            ['20260808', '20260816'],   // 8/8 〜 8/16 全天
        ],

        // ── 通知方式 ──────────────────────────────
        // 本地：设 true / false
        // 远程：填上密钥或 URL 即启用，留空则跳过。可以同时填多个
        notify: {
            // ── 本机 ──
            sound: true,        // 蜂鸣
            desktop: true,      // 桌面通知
            titleFlash: true,   // 标题栏闪烁
            alertBox: false,    // 弹窗（会阻塞脚本，慎用）

            // ── 微信 ──
            // PushPlus：https://www.pushplus.plus 微信扫码登录 → 复制 token
            pushplus: '',
            // Server酱³：https://sct.ftqq.com 微信扫码 → SendKey（形如 sctp123t...）
            serverchan: '',
            // 企业微信群机器人：群设置 → 群机器人 → 添加 → 复制 Webhook 地址
            wecom: '',

            // ── 手机弹窗 ──
            // Bark（iOS）：App Store 装 Bark → 复制 URL，形如 https://api.day.app/xxxxx
            bark: '',
            // Bark 提醒级别：'active' 普通 / 'timeSensitive' 专注模式也响 / 'critical' 静音也响
            barkLevel: 'timeSensitive',
            // ntfy（iOS/Android，开源免费）：装 ntfy App 订阅一个 topic，填 https://ntfy.sh/你的topic
            ntfy: '',

            // ── 其他 ──
            telegram: '',       // https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>
            discord: '',        // Discord Webhook URL
            webhook: '',        // 任意 URL，收到 POST {title, body, slots}
        },
    };

    // ══════════════════════════════════════════════════
    //  以下无需修改
    // ══════════════════════════════════════════════════

    const VERSION = '1.4.0';
    const SEP = '━━━━━━━━━━━━━━';
    const LOG_MAX = 300;          // 日志保留条数（跨页面）

    const K = {
        running: 'ikg_running',
        dir: 'ikg_dir',
        step: 'ikg_step',
        seen: 'ikg_seen',
        hits: 'ikg_hits',
        rounds: 'ikg_rounds',
        log: 'ikg_log',
        rules: 'ikg_rules',
    };

    const NEXT_URL = '/el32/pc/reserv/p03/p03a/nextWeek';
    const LAST_URL = '/el32/pc/reserv/p03/p03a/lastWeek';

    const ZIGEN_TIME = {
        1: '9:00', 2: '10:00', 3: '11:00', 4: '12:00',
        5: '13:00', 6: '14:00', 7: '15:00', 8: '16:00',
        9: '17:00', 10: '18:00', 11: '19:00', 12: '20:00',
    };

    const ls = {
        get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
        set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
    };

    // ── 空位解析 ─────────────────────────────────────

    /** 从当前页面解析所有可预约空位（status1 + a.simei） */
    function parseSlots() {
        const seen = new Set();
        const out = [];
        for (const a of document.querySelectorAll('a.simei')) {
            const d = a.dataset;
            if (!d.yoyaku || !d.zigen) continue;
            const key = `${d.yoyaku}-${d.zigen}`;
            if (seen.has(key)) continue;   // 两张转置表会重复
            seen.add(key);
            out.push({
                key,
                date: d.yoyaku,
                zigen: +d.zigen,
                time: d.time || ZIGEN_TIME[+d.zigen] || '?',
                week: d.week || '',
                label: d.date || '',
            });
        }
        return out.sort((x, y) => x.date.localeCompare(y.date) || x.zigen - y.zigen);
    }

    // ── 监控规则 ─────────────────────────────────────
    //
    // rules = {
    //   week:   [7][12] 布尔矩阵，week[0] = 周日 … week[6] = 周六
    //   ranges: [{ from:'YYYYMMDD', to:'YYYYMMDD', zigen:[1..12], label }]
    // }
    // 判定优先级：特定日期区间 > 星期表

    const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土'];

    /** 由 CFG 生成初始规则（首次使用或重置时） */
    function defaultRules() {
        const week = [];
        for (let d = 0; d < 7; d++) {
            const weekend = (d === 0 || d === 6);
            const allow = weekend
                ? (CFG.weekendZigen === null ? null : CFG.weekendZigen)
                : CFG.weekdayZigen;
            week.push(Array.from({ length: 12 }, (_, i) =>
                allow === null ? true : allow.includes(i + 1)));
        }
        const ranges = (CFG.fullDayRanges || []).map(([from, to]) => ({
            from, to, zigen: [1,2,3,4,5,6,7,8,9,10,11,12],
        }));
        return { week, ranges };
    }

    let RULES = null;

    function loadRules() {
        const r = ls.get(K.rules, null);
        if (r && Array.isArray(r.week) && r.week.length === 7) {
            r.ranges = r.ranges || [];
            return r;
        }
        return defaultRules();
    }

    function saveRules(r) {
        RULES = r;
        ls.set(K.rules, r);
    }

    /** "(土)" → 6；失败时用日期推算 */
    function dayOfWeek(date, weekStr) {
        const m = weekStr && weekStr.match(/[日月火水木金土]/);
        if (m) return WEEK_JA.indexOf(m[0]);
        if (date && date.length === 8) {
            return new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)).getDay();
        }
        return -1;
    }

    /** 该日期命中的特定区间（无则 null） */
    function matchRange(date) {
        if (!date) return null;
        return (RULES.ranges || []).find(r => date >= r.from && date <= r.to) || null;
    }

    /**
     * 判断某个时段是否是我们想监控的
     * 优先级：特定日期区间 > 星期表
     */
    function isWanted(date, zigen, weekStr) {
        const r = matchRange(date);
        if (r) return r.zigen.includes(zigen);
        const dow = dayOfWeek(date, weekStr);
        if (dow < 0) return false;
        return !!(RULES.week[dow] && RULES.week[dow][zigen - 1]);
    }

    const wanted = (s) => isWanted(s.date, s.zigen, s.week);

    const pretty = (s) =>
        `${s.date.slice(0, 4)}/${s.date.slice(4, 6)}/${s.date.slice(6)} ${s.week} ${s.zigen}限 ${s.time}`
        + (matchRange(s.date) ? ' [区间]' : '');

    // ── 通知 ─────────────────────────────────────────

    function beep(times = 3) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            let t = ctx.currentTime;
            for (let i = 0; i < times; i++) {
                const o = ctx.createOscillator();
                const g = ctx.createGain();
                o.connect(g); g.connect(ctx.destination);
                o.frequency.value = 880;
                g.gain.setValueAtTime(0.001, t);
                g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
                o.start(t); o.stop(t + 0.3);
                t += 0.4;
            }
        } catch (e) { /* 用户未交互时可能被拦，忽略 */ }
    }

    let flashTimer = null;
    function flashTitle(text) {
        if (flashTimer) clearInterval(flashTimer);
        const orig = document.title;
        let on = false;
        flashTimer = setInterval(() => {
            document.title = (on = !on) ? `🔴 ${text}` : orig;
        }, 700);
        // 用户一回到页面就停
        document.addEventListener('visibilitychange', function stop() {
            if (!document.hidden) {
                clearInterval(flashTimer); flashTimer = null;
                document.title = orig;
                document.removeEventListener('visibilitychange', stop);
            }
        });
    }

    /**
     * 检查响应体里的业务错误码。
     * HTTP 200 不代表成功 —— Server酱/PushPlus 等会在 JSON 里返回错误码。
     * @return null 表示成功，字符串表示错误说明
     */
    function bizError(text) {
        if (!text) return null;
        let j;
        try { j = JSON.parse(text); } catch { return null; }   // 非 JSON 视为成功
        // Server酱: code=0 / PushPlus: code=200 / 企业微信: errcode=0
        if ('errcode' in j && j.errcode !== 0) return `errcode=${j.errcode} ${j.errmsg || ''}`;
        if ('code' in j) {
            const ok = j.code === 0 || j.code === 200;
            if (!ok) return `code=${j.code} ${j.message || j.msg || ''}`;
        }
        return null;
    }

    /** 统一的 HTTP 发送。优先用 GM_xmlhttpRequest 以绕过跨域限制 */
    function send(name, opt) {
        const t0 = Date.now();

        const done = (ok, info, raw) => {
            const ms = Date.now() - t0;
            log(`${ok ? '✓' : '✗'} ${name} — ${info} (${ms}ms)`, !ok);
            // 失败时把服务器原始响应也打到面板与控制台，便于排查
            if (!ok && raw) {
                log(`   ↳ ${String(raw).slice(0, 200)}`, true);
            }
            console[ok ? 'log' : 'warn'](`[ikegami] ${name}`, { ok, info, url: opt.url, raw });
        };

        if (typeof GM_xmlhttpRequest === 'function') {
            GM_xmlhttpRequest({
                method: opt.method || 'GET',
                url: opt.url,
                headers: opt.headers || {},
                data: opt.data,
                timeout: 20000,
                onload: (r) => {
                    const httpOk = r.status >= 200 && r.status < 300;
                    if (!httpOk) return done(false, `HTTP ${r.status}`, r.responseText);
                    const err = bizError(r.responseText);
                    if (err) return done(false, err, r.responseText);
                    done(true, `HTTP ${r.status}`);
                },
                onerror: (e) => done(false, '连接失败（域名被拦截？检查油猴权限）', JSON.stringify(e)),
                ontimeout: () => done(false, '超时 20 秒'),
            });
        } else {
            // 没有 GM_xmlhttpRequest —— 说明 @grant 没生效
            log(`⚠ ${name}：GM_xmlhttpRequest 不可用，降级为 fetch（无法读取响应）`, true);
            fetch(opt.url, {
                method: opt.method || 'GET',
                mode: 'no-cors',
                headers: opt.headers || {},
                body: opt.data,
            }).then(() => done(true, '已发出（no-cors，无法确认结果）'))
              .catch((e) => done(false, '发送失败', e && e.message));
        }
    }

    const J = { 'Content-Type': 'application/json' };
    const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

    /**
     * 统一分发通知到所有已配置渠道
     * @param title 标题
     * @param body  正文（多行纯文本）
     * @param opt   { silent: 不响铃不闪标题, data: 附带给 webhook 的结构化数据 }
     */
    function dispatch(title, body, opt = {}) {
        const full = `${title}\n${body}`;
        const n = CFG.notify;

        // ── 本机 ──
        if (n.sound && !opt.silent) beep();
        if (n.titleFlash && !opt.silent) flashTitle(title);

        if (n.desktop) {
            if (typeof GM_notification === 'function') {
                GM_notification({ title: '池上教習所 — ' + title, text: body, timeout: 0 });
            } else if ('Notification' in window) {
                if (Notification.permission === 'granted') {
                    new Notification('池上教習所 — ' + title, { body, requireInteraction: true });
                } else if (Notification.permission !== 'denied') {
                    Notification.requestPermission().then(p => {
                        if (p === 'granted') new Notification('池上教習所 — ' + title, { body });
                    });
                }
            }
        }

        // ── 微信：PushPlus ──
        if (n.pushplus) {
            send('PushPlus', {
                method: 'POST',
                url: 'https://www.pushplus.plus/send',
                headers: J,
                data: JSON.stringify({
                    token: n.pushplus,
                    title: '教習所 ' + title,
                    content: `<pre style="font-family:monospace;font-size:13px">${body}</pre>`,
                    template: 'html',
                }),
            });
        }

        // ── 微信：Server酱³ ──
        if (n.serverchan) {
            const key = n.serverchan.trim();
            // sctp 开头 = Server酱³（新版），域名含 uid；否则为 Turbo（旧版）
            const m = key.match(/^sctp(\d+)t/);
            const url = m
                ? `https://${m[1]}.push.ft07.com/send/${key}.send`
                : `https://sctapi.ftqq.com/${key}.send`;
            // desp 支持 Markdown —— 用代码块包裹以保留换行与对齐
            const desp = '```\n' + body + '\n```';
            send('Server酱', {
                method: 'POST',
                url,
                headers: FORM,
                data: `title=${encodeURIComponent('教習所 ' + title)}&desp=${encodeURIComponent(desp)}`,
            });
        }

        // ── 微信：企业微信群机器人 ──
        if (n.wecom) {
            send('企业微信', {
                method: 'POST',
                url: n.wecom,
                headers: J,
                data: JSON.stringify({ msgtype: 'text', text: { content: '【教習所空位】\n' + body } }),
            });
        }

        // ── Bark（iOS 弹窗）──
        if (n.bark) {
            const base = n.bark.replace(/\/+$/, '');
            send('Bark', {
                url: `${base}/${encodeURIComponent('教習所 ' + title)}/${encodeURIComponent(body)}`
                     + `?sound=alarm&level=${n.barkLevel || 'timeSensitive'}&group=ikegami`,
            });
        }

        // ── ntfy ──
        if (n.ntfy) {
            send('ntfy', {
                method: 'POST',
                url: n.ntfy,
                headers: { 'Title': 'Ikegami', 'Priority': 'high', 'Tags': 'car' },
                data: full,
            });
        }

        // ── Telegram ──
        if (n.telegram) {
            const sep = n.telegram.includes('?') ? '&' : '?';
            send('Telegram', { url: `${n.telegram}${sep}text=${encodeURIComponent(full)}` });
        }

        // ── Discord ──
        if (n.discord) {
            send('Discord', {
                method: 'POST', url: n.discord, headers: J,
                data: JSON.stringify({ content: `**${title}**\n\`\`\`\n${body}\n\`\`\`` }),
            });
        }

        // ── 自定义 ──
        if (n.webhook) {
            send('Webhook', {
                method: 'POST', url: n.webhook, headers: J,
                data: JSON.stringify({ title, body, ...(opt.data || {}) }),
            });
        }

        if (n.alertBox && !opt.silent) alert(`${title}\n\n${body}`);
    }

    /** 发现新空位时的通知 */
    function notify(slots) {
        dispatch(`空位 ${slots.length} 件`, slots.map(pretty).join('\n'), { data: { slots } });
    }

    // ── 当前页面完整快照 ──────────────────────────────

    /**
     * 读取当前页日历的完整状态。
     * 结构见 README §2：.yoyakuTable 的 tr.date 每行一天，12 个 td 对应 12 限。
     * 日期来自 td.view（两张转置表都有，按文本去重后取前 7 个）。
     */
    function readCalendar() {
        // 1) 日期表头
        const seenTxt = new Set();
        const days = [];
        for (const td of document.querySelectorAll('td.view')) {
            const raw = (td.innerText || '').replace(/\s+/g, '');
            if (!raw || seenTxt.has(raw)) continue;
            seenTxt.add(raw);
            const m = raw.match(/(\d+)月(\d+)日[（(]?(.)/);
            days.push({
                text: raw,
                md: m ? `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}` : raw,
                week: m ? m[3] : '',
            });
            if (days.length >= 7) break;
        }

        // 2) 每天各时限的状态
        const rows = [...document.querySelectorAll('.yoyakuTable tr.date')];
        rows.forEach((tr, i) => {
            if (!days[i]) return;
            const open = [], booked = [];
            [...tr.children].forEach((td, j) => {
                const zigen = j + 1;
                if (td.querySelector('a.simei')) open.push(zigen);
                else if (td.querySelector('a.cancel') || td.classList.contains('status3')) {
                    booked.push({ zigen, name: (td.innerText || '').trim() });
                }
            });
            days[i].open = open;
            days[i].booked = booked;
            // 该行若有任意链接，可直接取到完整日期 YYYYMMDD
            const a = tr.querySelector('a[data-yoyaku]');
            if (a) days[i].date = a.dataset.yoyaku;
        });

        const result = days.filter(d => d.open !== undefined);
        fillMissingDates(result);
        return result;
    }

    /**
     * 补全没有链接、因而拿不到 data-yoyaku 的日期。
     * 以已知的某天为锚点按天数偏移推算；整周都无链接时退回「当前年份 + 页面月日」。
     */
    function fillMissingDates(days) {
        const pad = (n) => String(n).padStart(2, '0');
        const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;

        const anchor = days.findIndex(d => d.date);
        if (anchor >= 0) {
            const s = days[anchor].date;
            const base = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
            days.forEach((d, i) => {
                if (d.date) return;
                const dt = new Date(base);
                dt.setDate(base.getDate() + (i - anchor));
                d.date = fmt(dt);
            });
            return;
        }

        // 整周无链接：用页面上的月日 + 推定年份
        const now = new Date();
        days.forEach(d => {
            const m = d.text.match(/(\d+)月(\d+)日/);
            if (!m) return;
            const mo = +m[1], dy = +m[2];
            // 页面月份比当前月份小很多时，判定为跨年
            let y = now.getFullYear();
            if (mo < now.getMonth() + 1 - 6) y += 1;
            d.date = `${y}${pad(mo)}${pad(dy)}`;
        });
    }

    /** 把小时数组压成 "9 15 16 17 19" 形式 */
    const hours = (zs) => zs.map(z => (ZIGEN_TIME[z] || '?').split(':')[0]).join(' ');

    /** 生成人类可读的现况文本 */
    function formatSnapshot(days) {
        const lines = [];
        let total = 0, hitTotal = 0;
        const hitLines = [];

        for (const d of days) {
            const open = d.open || [];
            total += open.length;
            const full = !!matchRange(d.date);
            const hit = open.filter(z => isWanted(d.date, z, d.week));
            hitTotal += hit.length;

            let line = `${d.md}(${d.week})${full ? '◎' : ' '}`.padEnd(11, ' ');
            if (!open.length) {
                line += '―';
            } else {
                line += `${hours(open)}時`;
                if (hit.length) line += `  ★${hit.length}`;
            }
            if (d.booked && d.booked.length) {
                line += `  [予約:${hours(d.booked.map(b => b.zigen))}時]`;
            }
            lines.push(line);

            if (hit.length) hitLines.push(`★ ${d.md}(${d.week}) ${hours(hit)}時`);
        }

        const anyFull = days.some(d => matchRange(d.date));
        const body = [
            ...lines,
            '─────────────',
            `空位 ${total} 件 / 命中条件 ${hitTotal} 件`,
            ...(anyFull ? ['◎ = 特定日期区间'] : []),
            ...(hitLines.length ? ['', ...hitLines] : []),
        ].join('\n');

        return { body, total, hitTotal };
    }

    /** 面板「发送现况」按钮 —— 把当前页完整情况推到各渠道 */
    function sendSnapshot() {
        if (!isCalendarPage()) {
            log('当前不是日历页，无法生成现况', true);
            return;
        }
        const days = readCalendar();
        if (!days.length) {
            log('未能解析出日期行 —— 页面结构可能已变更', true);
            return;
        }
        const { body, total, hitTotal } = formatSnapshot(days);
        const span = `${days[0].md}〜${days[days.length - 1].md}`;
        const title = `現況 ${span} 空${total}/命中${hitTotal}`;

        log(`发送现况：${span}，空位 ${total} 件，命中 ${hitTotal} 件`);
        body.split('\n').forEach(l => log('  ' + l));

        dispatch(title, body, { silent: true, data: { days } });
    }

    /** 当前已启用的远程推送渠道名 */
    function enabledChannels() {
        const n = CFG.notify;
        return [
            n.serverchan && 'Server酱', n.pushplus && 'PushPlus', n.wecom && '企业微信',
            n.bark && 'Bark', n.ntfy && 'ntfy', n.telegram && 'Telegram',
            n.discord && 'Discord', n.webhook && 'Webhook',
        ].filter(Boolean);
    }

    /** 测试通知链路 */
    function testNotify() {
        const ch = enabledChannels();
        if (!ch.length) {
            log('⚠ 没有配置任何推送渠道 —— 什么都不会发出', true);
            log('   请在脚本顶部 CFG.notify 里填入 serverchan / bark 等的密钥', true);
            log('   注意：必须在【油猴编辑器】里改，改本地文件不生效', true);
            beep(2);
            return;
        }
        log(`正在向 ${ch.length} 个渠道发送测试：${ch.join('、')}`);
        dispatch('通知测试', [
            '这是一条测试消息。',
            '若你收到了，说明该渠道配置正确。',
            '',
            '08/25(火)  19 20時  ★2',
            '08/23(日)  9 15 16 17 19時  ★5',
        ].join('\n'));
    }

    // ── 导航 ─────────────────────────────────────────

    /** 找「次の週 / 前の週」按钮 */
    function findNavButton(kind) {
        const rx = kind === 'next' ? /nextWeek/i : /lastWeek/i;
        const words = kind === 'next'
            ? ['次の週', '翌週', '次週', '次へ']
            : ['前の週', '先週', '前週', '前へ'];

        // 1) onclick 属性里直接含端点名
        for (const el of document.querySelectorAll('[onclick]')) {
            if (rx.test(el.getAttribute('onclick') || '')) return el;
        }
        // 2) 按可见文本
        for (const el of document.querySelectorAll('a,button,input[type=button],input[type=submit]')) {
            const t = (el.innerText || el.value || '').trim();
            if (words.some(w => t.includes(w))) return el;
        }
        // 3) 按 id / class 关键字
        const sel = kind === 'next' ? '[id*=next i],[class*=next i]' : '[id*=last i],[id*=prev i],[class*=prev i]';
        return document.querySelector(sel);
    }

    /** 兜底：直接构造表单 POST（参数取自页面上现有的 input） */
    function submitForm(kind) {
        const fields = {
            schoolCd: '', lastScreenCd: '', dateInformationType: '',
            groupCd: '1', instructorTypeCd: '0', page: '1',
            changeInstructorFlg: '0', carModelCd: '301', instructorCd: '0',
            infoPeriodNumber: '', nominationInstructorCd: '0',
            kamokuCd: '0', selectTime: '',
        };
        // 用页面里实际存在的值覆盖默认值
        for (const name of Object.keys(fields)) {
            const el = document.querySelector(`[name="${name}"]`);
            if (el && el.value !== undefined && el.value !== '') fields[name] = el.value;
        }
        // 翻周时清空「选中项」相关字段
        fields.dateInformationType = '';
        fields.infoPeriodNumber = '';
        fields.selectTime = '';

        const f = document.createElement('form');
        f.method = 'POST';
        f.action = kind === 'next' ? NEXT_URL : LAST_URL;
        for (const [k, v] of Object.entries(fields)) {
            const i = document.createElement('input');
            i.type = 'hidden'; i.name = k; i.value = v;
            f.appendChild(i);
        }
        document.body.appendChild(f);
        f.submit();
    }

    function navigate(kind) {
        const btn = findNavButton(kind);
        if (btn) { btn.click(); return true; }
        log(`未找到「${kind === 'next' ? '次の週' : '前の週'}」按钮，改用表单提交`);
        submitForm(kind);
        return true;
    }

    // ── 错误检测 ─────────────────────────────────────

    function isErrorPage() {
        const t = document.body ? document.body.innerText : '';
        return t.includes('EC05') || t.includes('システムエラー');
    }

    function isCalendarPage() {
        return !!document.querySelector('.yoyakuTable, td[class^=status]');
    }

    // ── UI 面板 ──────────────────────────────────────

    let $panel, $log, $status;

    function buildPanel() {
        $panel = document.createElement('div');
        $panel.style.cssText = `
            position:fixed; right:12px; bottom:12px; z-index:2147483647;
            width:330px; max-height:70vh; display:flex; flex-direction:column;
            font:12px/1.5 -apple-system,"Segoe UI",Meiryo,sans-serif;
            background:#1e1e24; color:#e8e8ea; border-radius:10px;
            box-shadow:0 6px 28px rgba(0,0,0,.4); overflow:hidden;`;

        const head = document.createElement('div');
        head.style.cssText = 'padding:9px 12px;background:#2b2b34;display:flex;align-items:center;gap:6px;';
        head.innerHTML =
            `<strong>空位监视</strong>` +
            `<span style="flex:1;font-size:10px;color:#7a7a88">v${VERSION}</span>`;

        const mkBtn = (text, tip, bg, fn) => {
            const b = document.createElement('button');
            b.textContent = text;
            b.title = tip;
            b.style.cssText =
                `padding:4px 10px;border:0;border-radius:5px;cursor:pointer;background:${bg};color:#e8e8ea;`;
            b.onclick = fn;
            head.appendChild(b);
            return b;
        };

        mkBtn('⚙', '设置监控的星期／时段／特定日期区间', '#4a4a56', openSettings);
        mkBtn('测试', '发一条测试消息，检查各渠道是否配置正确', '#3d3d48', testNotify);
        mkBtn('现况', '把当前这一周的完整空位情况推送到各渠道', '#3a5f8a', sendSnapshot);
        mkBtn('📋', '复制全部日志到剪贴板', '#3d3d48', copyLog);
        mkBtn('🗑', '清空日志', '#3d3d48', clearLog);

        const btn = document.createElement('button');
        btn.style.cssText = 'padding:4px 12px;border:0;border-radius:5px;cursor:pointer;font-weight:600;';
        head.appendChild(btn);

        $status = document.createElement('div');
        $status.style.cssText = 'padding:7px 12px;background:#25252d;font-size:11px;color:#9a9aa8;';

        $log = document.createElement('div');
        $log.style.cssText = 'flex:1;overflow-y:auto;padding:8px 12px;';

        $panel.append(head, $status, $log);
        document.body.appendChild($panel);

        const paint = () => {
            const on = ls.get(K.running, false);
            btn.textContent = on ? '■ 停止' : '▶ 开始';
            btn.style.background = on ? '#d9534f' : '#4a9d5f';
            btn.style.color = '#fff';
        };
        btn.onclick = () => {
            const on = !ls.get(K.running, false);
            ls.set(K.running, on);
            if (on) {
                ls.set(K.dir, 'next'); ls.set(K.step, 0);
                ls.set(K.rounds, 0); ls.set(K.seen, []);
                log('▶ 已开始');
                tick();
            } else {
                if (timer) { clearTimeout(timer); timer = null; }
                log('■ 已停止');
            }
            paint();
        };
        paint();
    }

    /** 渲染单条日志到面板 */
    function renderLog(e, prepend = true) {
        if (!$log) return;
        const d = document.createElement('div');
        d.style.cssText =
            `padding:3px 0;border-bottom:1px solid #2f2f38;white-space:pre-wrap;word-break:break-all;`
            + (e.h ? 'color:#ffd75f;font-weight:600;' : '');
        d.textContent = `${e.t}  ${e.m}`;
        if (prepend) $log.prepend(d); else $log.appendChild(d);
        while ($log.children.length > LOG_MAX) $log.lastChild.remove();
    }

    /**
     * 记录日志。
     * 翻周是整页跳转，面板会重建 —— 因此同时写入 localStorage，
     * 页面加载后恢复，跨页面保留完整历史。
     */
    function log(msg, hi) {
        const e = { t: new Date().toLocaleTimeString('ja-JP'), m: String(msg), h: !!hi };
        try {
            const arr = ls.get(K.log, []);
            arr.unshift(e);
            if (arr.length > LOG_MAX) arr.length = LOG_MAX;
            ls.set(K.log, arr);
        } catch { /* 配额满等情况忽略 */ }
        renderLog(e, true);
    }

    /** 页面加载后恢复历史日志 */
    function restoreLog() {
        const arr = ls.get(K.log, []);
        if (!arr.length) return;
        // 数组头部是最新，按序 append 即可保持「新在上」
        arr.forEach(e => renderLog(e, false));
        renderLog({ t: '', m: `── 以上为历史记录（共 ${arr.length} 条）──`, h: false }, false);
    }

    function clearLog() {
        ls.set(K.log, []);
        if ($log) $log.innerHTML = '';
        log('日志已清空');
    }

    /** 复制全部日志 —— 便于排查问题时整段粘贴 */
    function copyLog() {
        const arr = ls.get(K.log, []);
        const text = arr.map(e => `${e.t}  ${e.m}`).reverse().join('\n');
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;opacity:0;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } finally { ta.remove(); }
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(fallback);
        } else {
            fallback();
        }
        log(`已复制 ${arr.length} 条日志到剪贴板`);
    }

    function setStatus(s) { if ($status) $status.textContent = s; }

    // ── 设置界面 ─────────────────────────────────────

    /** 打开「监控条件」设置对话框 */
    function openSettings() {
        const draft = JSON.parse(JSON.stringify(RULES));   // 编辑副本，取消时丢弃

        const mask = document.createElement('div');
        mask.style.cssText = `
            position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,.55);
            display:flex; align-items:center; justify-content:center;
            font:13px/1.6 -apple-system,"Segoe UI",Meiryo,sans-serif;`;

        const box = document.createElement('div');
        box.style.cssText = `
            background:#1e1e24; color:#e8e8ea; border-radius:12px; padding:18px 20px;
            max-height:88vh; overflow-y:auto; box-shadow:0 10px 40px rgba(0,0,0,.5);
            min-width:560px;`;
        mask.appendChild(box);

        const h = (tag, css, txt) => {
            const e = document.createElement(tag);
            if (css) e.style.cssText = css;
            if (txt != null) e.textContent = txt;
            return e;
        };

        box.appendChild(h('div', 'font-size:16px;font-weight:700;margin-bottom:4px;', '监控条件设置'));
        box.appendChild(h('div', 'color:#9a9aa8;font-size:11px;margin-bottom:14px;',
            '点格子切换。绿色 = 监控该时段。特定日期区间优先于星期表。'));

        // ── 星期 × 时限 网格 ──
        box.appendChild(h('div', 'font-weight:600;margin-bottom:6px;', '按星期'));

        const grid = h('table', 'border-collapse:collapse;margin-bottom:10px;');
        const thead = h('tr');
        thead.appendChild(h('th', 'width:34px;'));
        for (let z = 1; z <= 12; z++) {
            thead.appendChild(h('th',
                'font-size:10px;color:#9a9aa8;font-weight:500;padding:0 0 4px;width:34px;',
                ZIGEN_TIME[z].split(':')[0]));
        }
        grid.appendChild(thead);

        const cells = [];                      // cells[dow][zigen-1]
        for (let d = 0; d < 7; d++) {
            const tr = h('tr');
            const isWk = (d === 0 || d === 6);
            tr.appendChild(h('td',
                `font-size:12px;text-align:center;padding-right:4px;${isWk ? 'color:#ff9a9a;' : ''}`,
                WEEK_JA[d]));
            cells[d] = [];
            for (let z = 1; z <= 12; z++) {
                const td = h('td', 'padding:1px;');
                const cell = h('div',
                    'width:32px;height:24px;border-radius:4px;cursor:pointer;transition:background .12s;');
                const paint = () => {
                    cell.style.background = draft.week[d][z - 1] ? '#3f9b5c' : '#33333d';
                };
                cell.onclick = () => { draft.week[d][z - 1] = !draft.week[d][z - 1]; paint(); };
                paint();
                cells[d][z - 1] = { el: cell, paint };
                td.appendChild(cell);
                tr.appendChild(td);
            }
            grid.appendChild(tr);
        }
        box.appendChild(grid);

        const repaintGrid = () => {
            for (let d = 0; d < 7; d++)
                for (let z = 0; z < 12; z++) cells[d][z].paint();
        };

        // ── 快捷预设 ──
        const presets = h('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;');
        const preset = (label, fn) => {
            const b = h('button',
                'padding:4px 10px;border:0;border-radius:5px;cursor:pointer;'
                + 'background:#33333d;color:#c8c8d0;font-size:11px;', label);
            b.onclick = () => { fn(); repaintGrid(); };
            presets.appendChild(b);
        };
        const setAll = (v) => { for (let d = 0; d < 7; d++) for (let z = 0; z < 12; z++) draft.week[d][z] = v; };
        preset('全选', () => setAll(true));
        preset('全清', () => setAll(false));
        preset('平日夜间 19–20', () => {
            for (let d = 1; d <= 5; d++)
                for (let z = 0; z < 12; z++) draft.week[d][z] = (z === 10 || z === 11);
        });
        preset('周末全天', () => {
            for (const d of [0, 6]) for (let z = 0; z < 12; z++) draft.week[d][z] = true;
        });
        preset('反选', () => {
            for (let d = 0; d < 7; d++) for (let z = 0; z < 12; z++) draft.week[d][z] = !draft.week[d][z];
        });
        box.appendChild(presets);

        // ── 特定日期区间 ──
        box.appendChild(h('div', 'font-weight:600;margin-bottom:2px;', '特定日期区间'));
        box.appendChild(h('div', 'color:#9a9aa8;font-size:11px;margin-bottom:8px;',
            '优先于上面的星期表。适合暑假、连休等能整天来的时期。'));

        const listBox = h('div', 'margin-bottom:10px;');
        box.appendChild(listBox);

        const isoToInput = (s) => s && s.length === 8
            ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : '';
        const inputToIso = (s) => (s || '').replace(/-/g, '');

        function renderRanges() {
            listBox.innerHTML = '';
            if (!draft.ranges.length) {
                listBox.appendChild(h('div', 'color:#6a6a78;font-size:11px;padding:4px 0;', '（无）'));
            }
            draft.ranges.forEach((r, idx) => {
                const row = h('div',
                    'display:flex;align-items:center;gap:6px;padding:6px;margin-bottom:6px;'
                    + 'background:#25252d;border-radius:6px;flex-wrap:wrap;');

                const mkDate = (val, on) => {
                    const i = h('input');
                    i.type = 'date';
                    i.value = isoToInput(val);
                    i.style.cssText =
                        'background:#33333d;border:0;border-radius:4px;color:#e8e8ea;'
                        + 'padding:3px 6px;font-size:11px;color-scheme:dark;';
                    i.onchange = () => on(inputToIso(i.value));
                    return i;
                };
                row.appendChild(mkDate(r.from, v => { r.from = v; }));
                row.appendChild(h('span', 'color:#9a9aa8;', '〜'));
                row.appendChild(mkDate(r.to, v => { r.to = v; }));

                // 该区间的时限选择
                const zbox = h('div', 'display:flex;gap:1px;margin-left:4px;');
                const zcells = [];
                for (let z = 1; z <= 12; z++) {
                    const c = h('div',
                        'width:24px;height:20px;border-radius:3px;cursor:pointer;font-size:9px;'
                        + 'display:flex;align-items:center;justify-content:center;',
                        ZIGEN_TIME[z].split(':')[0]);
                    const paint = () => {
                        const on = r.zigen.includes(z);
                        c.style.background = on ? '#3f9b5c' : '#33333d';
                        c.style.color = on ? '#fff' : '#7a7a88';
                    };
                    c.onclick = () => {
                        const i = r.zigen.indexOf(z);
                        if (i >= 0) r.zigen.splice(i, 1); else r.zigen.push(z);
                        r.zigen.sort((a, b) => a - b);
                        paint();
                    };
                    paint();
                    zcells.push(paint);
                    zbox.appendChild(c);
                }
                row.appendChild(zbox);

                const all = h('button',
                    'padding:2px 8px;border:0;border-radius:4px;cursor:pointer;'
                    + 'background:#33333d;color:#c8c8d0;font-size:10px;', '全天');
                all.onclick = () => {
                    r.zigen = [1,2,3,4,5,6,7,8,9,10,11,12];
                    zcells.forEach(p => p());
                };
                row.appendChild(all);

                const del = h('button',
                    'padding:2px 8px;border:0;border-radius:4px;cursor:pointer;'
                    + 'background:#5a3336;color:#ffb3b3;font-size:10px;margin-left:auto;', '删除');
                del.onclick = () => { draft.ranges.splice(idx, 1); renderRanges(); };
                row.appendChild(del);

                listBox.appendChild(row);
            });
        }
        renderRanges();

        const addBtn = h('button',
            'padding:5px 12px;border:0;border-radius:5px;cursor:pointer;'
            + 'background:#33333d;color:#c8c8d0;font-size:11px;margin-bottom:16px;', '+ 添加区间');
        addBtn.onclick = () => {
            const t = new Date();
            const iso = (dt) => `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}`
                              + String(dt.getDate()).padStart(2, '0');
            const end = new Date(t); end.setDate(t.getDate() + 7);
            draft.ranges.push({ from: iso(t), to: iso(end), zigen: [1,2,3,4,5,6,7,8,9,10,11,12] });
            renderRanges();
        };
        box.appendChild(addBtn);

        // ── 底部按钮 ──
        const foot = h('div', 'display:flex;gap:8px;justify-content:flex-end;');
        const mk = (label, bg, fn) => {
            const b = h('button',
                `padding:7px 18px;border:0;border-radius:6px;cursor:pointer;`
                + `background:${bg};color:#fff;font-weight:600;`, label);
            b.onclick = fn;
            foot.appendChild(b);
        };
        mk('重置为默认', '#4a4a56', () => {
            if (confirm('恢复为脚本内 CFG 的默认条件？')) {
                Object.assign(draft, defaultRules());
                repaintGrid(); renderRanges();
            }
        });
        mk('取消', '#4a4a56', () => mask.remove());
        mk('保存', '#3f9b5c', () => {
            draft.ranges = draft.ranges.filter(r => r.from && r.to && r.zigen.length);
            saveRules(draft);
            ls.set(K.seen, []);                       // 条件变了，重置已见快照
            mask.remove();
            log('已保存监控条件，已见快照一并重置');
            logRulesSummary();
        });
        box.appendChild(foot);

        mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
        document.body.appendChild(mask);
    }

    /** 把当前规则摘要打进日志 */
    function logRulesSummary() {
        const parts = [];
        for (let d = 0; d < 7; d++) {
            const on = [];
            for (let z = 1; z <= 12; z++) if (RULES.week[d][z - 1]) on.push(ZIGEN_TIME[z].split(':')[0]);
            if (!on.length) continue;
            parts.push(`${WEEK_JA[d]}:${on.length === 12 ? '全天' : on.join(',')}`);
        }
        log(parts.length ? `条件 ${parts.join(' / ')}` : '⚠ 未选择任何时段 —— 不会有通知', !parts.length);
        for (const r of (RULES.ranges || [])) {
            const z = r.zigen.length === 12 ? '全天' : r.zigen.map(x => ZIGEN_TIME[x].split(':')[0]).join(',');
            log(`区间 ${r.from.slice(4, 6)}/${r.from.slice(6)}〜${r.to.slice(4, 6)}/${r.to.slice(6)}  ${z}`);
        }
    }

    // ── 主循环 ───────────────────────────────────────

    let timer = null;

    function tick() {
        if (!ls.get(K.running, false)) return;

        if (isErrorPage()) {
            ls.set(K.running, false);
            log('⚠ 检测到 EC05 / 系统错误 —— 已自动停止', true);
            beep(5);
            setStatus('已停止（EC05）');
            return;
        }
        if (!isCalendarPage()) {
            log('当前不是日历页，等待…');
            setStatus('等待日历页');
            return;
        }

        // 1) 扫描
        const all = parseSlots();
        const hit = all.filter(wanted);

        // 2) diff
        const seen = new Set(ls.get(K.seen, []));
        const fresh = hit.filter(s => !seen.has(s.key));
        hit.forEach(s => seen.add(s.key));
        ls.set(K.seen, [...seen]);

        const rounds = ls.get(K.rounds, 0) + 1;
        ls.set(K.rounds, rounds);

        log(`扫描：本页 ${all.length} 个空位，命中条件 ${hit.length} 个${fresh.length ? `，新增 ${fresh.length}` : ''}`);

        if (fresh.length) {
            fresh.forEach(s => log('★ ' + pretty(s), true));
            notify(fresh);
        }

        // 3) 计划下一次导航
        const dir = ls.get(K.dir, 'next');
        let step = ls.get(K.step, 0);
        const span = Math.max(2, CFG.sweepWeeks) - 1;

        let nextDir = dir;
        if (dir === 'next') {
            step += 1;
            if (step >= span) nextDir = 'prev';
        } else {
            step -= 1;
            if (step <= 0) nextDir = 'next';
        }
        ls.set(K.step, step);
        ls.set(K.dir, nextDir);

        const wait = CFG.intervalMs + Math.round((Math.random() * 2 - 1) * CFG.jitterMs);
        const secs = Math.round(wait / 1000);
        setStatus(`第 ${rounds} 轮 · 累计命中 ${seen.size} · ${secs} 秒后点「${dir === 'next' ? '次の週' : '前の週'}」`);
        log(`${secs} 秒后 → ${dir === 'next' ? '次の週' : '前の週'}`);

        timer = setTimeout(() => {
            if (!ls.get(K.running, false)) return;
            navigate(dir);
        }, wait);
    }

    // ── 启动 ─────────────────────────────────────────

    function boot() {
        RULES = loadRules();        // 规则须在面板与扫描之前就绪
        buildPanel();
        restoreLog();               // 先恢复历史，新日志会叠在其上
        const on = ls.get(K.running, false);
        setStatus(on ? '运行中…' : '已停止 — 点「开始」');

        // 列出已启用的推送渠道，便于确认配置是否生效
        const remote = enabledChannels();
        if (remote.length) {
            log(`推送渠道：${remote.join('、')}`);
        } else {
            log('⚠ 推送渠道：未配置 —— 手机收不到任何消息', true);
            log('   在 CFG.notify 里填 serverchan / bark 等密钥（须在油猴编辑器内修改）', true);
        }

        logRulesSummary();
        log(`往返跨度：${CFG.sweepWeeks} 周 · 间隔 ${Math.round(CFG.intervalMs / 1000)} 秒`);
        log(`${SEP} 页面载入 v${VERSION}`);

        if (on) setTimeout(tick, 1200);   // 等页面渲染稳定
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
