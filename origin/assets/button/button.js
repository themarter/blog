/* ============================================================
   首页 · 公共按钮

   需求：按一下 = 按下（并一直保持着），再按一下 = 弹起；
   而且这个「按着」的状态要留给下一个打开页面的人。

   状态存在自己搭的 Cloudflare Worker + KV 上（不依赖第三方）：
     - 读：GET  https://img.marteria.top/api/button      -> {ok, state:{down,n,t}}
     - 写：POST https://img.marteria.top/api/button      body = {down, n}
       时间戳 t 由服务器盖（Date.now()），所以「上次按下」是全网一致的具体时间
     - KV 不过期，所以不会像以前挂在 ntfy.sh 那样 12 小时自己弹回去
   连不上服务器时退回 localStorage，至少「自己下次来」还是按着的。
   ============================================================ */

(function () {
    'use strict';

    const API = 'https://img.marteria.top/api/button';
    const LOCAL_KEY = 'pb.state';
    const POLL_MS = 30000;       // 兜底轮询
    const TIMEOUT_MS = 8000;

    const root = document.querySelector('.pb');
    const btn = document.getElementById('pb-btn');
    const btnText = document.getElementById('pb-btn-text');
    const stateEl = document.getElementById('pb-state');
    const countEl = document.getElementById('pb-count');
    const timeEl = document.getElementById('pb-time');
    const footEl = document.getElementById('pb-foot');

    if (!root || !btn) return;

    /** @type {{down: boolean, n: number, t: number}} */
    let state = { down: false, n: 0, t: 0 };
    let pending = false;

    /* ---------------- 渲染 ---------------- */

    function apply(next) {
        state = next;
        root.classList.toggle('is-down', next.down);
        btn.setAttribute('aria-pressed', next.down ? 'true' : 'false');
        btnText.textContent = next.down ? '弹起来' : '按下去';
        stateEl.textContent = next.down ? '按下中' : '弹起';
        countEl.textContent = next.n > 0 ? '共被按过 ' + next.n + ' 次' : '还没被按过';
        renderTime();
    }

    function pad(n) { return n < 10 ? '0' + n : String(n); }

    /* 具体到秒的绝对时间，就近用浏览器本地时区 */
    function absTime(ms) {
        const d = new Date(ms);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function relTime(ms) {
        const d = Math.max(0, (Date.now() - ms) / 1000);
        if (d < 45) return '刚刚';
        if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
        if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
        return Math.floor(d / 86400) + ' 天前';
    }

    function renderTime() {
        if (!state.t) {
            timeEl.textContent = '等第一个人';
            return;
        }
        timeEl.textContent = absTime(state.t) + (state.down ? ' 按下' : ' 弹起') +
            '（' + relTime(state.t) + '）';
    }

    /* 首屏那几百毫秒还没问到服务器，先把读数压暗，别让人看到假的「弹起」 */
    function startLoading() {
        root.classList.add('is-loading');
        btn.disabled = true;
        if (!state.t) {
            stateEl.textContent = '同步中';
            countEl.textContent = '—';
            timeEl.textContent = '稍等';
        }
    }

    function endLoading() {
        if (!root.classList.contains('is-loading')) return;
        root.classList.remove('is-loading');
        btn.disabled = false;
        if (!state.t) {
            stateEl.textContent = state.down ? '按下中' : '弹起';
            countEl.textContent = '还没被按过';
            timeEl.textContent = '等第一个人';
        }
        renderTime();
    }

    function setOffline(off) {
        root.classList.toggle('is-offline', off);
        footEl.textContent = off
            ? '连不上服务器，这一次只记在你这台机器的浏览器里。'
            : '状态存在 img.marteria.top 的 KV 里，不会过期；两个人同时按以服务器时间为准。';
    }

    /* ---------------- 本地缓存 ---------------- */

    function saveLocal(s) {
        try {
            localStorage.setItem(LOCAL_KEY, JSON.stringify(s));
        } catch (e) { /* 隐私模式下写不进去，不影响使用 */ }
    }

    function loadLocal() {
        try {
            const raw = localStorage.getItem(LOCAL_KEY);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (typeof s.down !== 'boolean') return null;
            return { down: s.down, n: Number(s.n) || 0, t: Number(s.t) || 0 };
        } catch (e) {
            return null;
        }
    }

    /* ---------------- 远端读写 ---------------- */

    function normalize(raw) {
        if (!raw || typeof raw.down !== 'boolean') return null;
        return { down: raw.down, n: Number(raw.n) || 0, t: Number(raw.t) || 0 };
    }

    function ctrl() {
        if (typeof AbortController === 'undefined') return undefined;
        const c = new AbortController();
        setTimeout(function () { c.abort(); }, TIMEOUT_MS);
        return c.signal;
    }

    async function fetchState() {
        const res = await fetch(API + '?t=' + Date.now(), {
            cache: 'no-store',
            signal: ctrl()
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        return normalize(body && body.state);
    }

    async function publish(s) {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ down: s.down, n: s.n }),
            signal: ctrl()
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const body = await res.json();
        return normalize(body && body.state);
    }

    /* 收到的远端状态可能比本地旧：刚发出去的那条，下一次轮询不一定已经读得到。
       用「第几次按」当版本号，旧的丢掉，否则会出现「按下去又被旧消息顶回弹起」。 */
    function applyRemote(remote) {
        if (!remote || remote.n < state.n) return false;
        apply(remote);
        saveLocal(remote);
        return true;
    }

    /* ---------------- 交互 ---------------- */

    async function press() {
        if (pending) return;
        pending = true;

        const next = { down: !state.down, n: state.n + 1, t: Date.now() };
        apply(next);          // 先动，别等网络
        saveLocal(next);

        try {
            const s = await publish(next);   // 服务器会把 t 换成它自己的时间
            if (s) {
                apply(s);
                saveLocal(s);
            }
            setOffline(false);
        } catch (e) {
            setOffline(true);
        }
        pending = false;
    }

    btn.addEventListener('click', press);

    /* ---------------- 启动 ---------------- */

    const local = loadLocal();
    if (local) apply(local);
    else apply(state);

    startLoading();
    // 网络太差时别把按钮按死，4 秒后无论如何放开
    setTimeout(endLoading, 4000);

    (async function boot() {
        try {
            const remote = await fetchState();
            if (remote) applyRemote(remote);
            setOffline(false);
        } catch (e) {
            setOffline(true);
        } finally {
            endLoading();
        }
    })();

    setInterval(function () {
        fetchState().then(function (s) {
            if (applyRemote(s)) setOffline(false);
        }).catch(function () { /* 网络抖一下不提示，别吓人 */ });
    }, POLL_MS);

    setInterval(renderTime, 15000);   // 「几分钟前」自己走

    // 从别的标签页切回来，立刻对一次
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            fetchState().then(function (s) {
                applyRemote(s);
            }).catch(function () { /* 忽略 */ });
        }
    });
})();
