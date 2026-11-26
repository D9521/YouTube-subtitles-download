// ==UserScript==
// @name         YouTube 字幕快速下載 (SRT / TXT - PO Token 修復版)
// @name:en      YouTube Subtitle Quick Downloader (SRT / TXT - PO Token Fix)
// @namespace    https://greasyfork.org/users/你的名字
// @version      1.0.0
// @description  自動捕獲 YouTube 播放器的 PO Token (pot)，解決字幕下載失敗問題，支援下載 SRT 與 TXT 格式
// @description:en Automatically captures YouTube player's PO Token (pot) to download SRT and TXT subtitles reliably
// @author       D9521
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @match        *://www.youtube.com/*
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const potCache = new Map(); // videoId -> { pot, potc, c }
    let origFetch = null;

    // ---------------------------------------------------------
    // 1. 捕獲播放器產生的 PO Token (pot)
    // ---------------------------------------------------------
    function capturePotFromUrl(urlStr) {
        if (!urlStr || typeof urlStr !== 'string' || !urlStr.includes('/api/timedtext')) return;
        try {
            const url = new URL(urlStr, location.origin);
            const v = url.searchParams.get('v');
            const pot = url.searchParams.get('pot');
            if (v && pot) {
                potCache.set(v, {
                    pot,
                    potc: url.searchParams.get('potc') || '1',
                    c: url.searchParams.get('c') || 'WEB'
                });
            }
        } catch (_) {}
    }

    // Hook fetch 與 XHR，第一時間攔截播放器發出的 timedtext 請求
    try {
        origFetch = pageWin.fetch.bind(pageWin);
        pageWin.fetch = function (...args) {
            const input = args[0];
            const url = typeof input === 'string' ? input : input?.url;
            if (url) capturePotFromUrl(url);
            return origFetch(...args);
        };
    } catch (_) {
        origFetch = window.fetch.bind(window);
    }

    try {
        const origOpen = pageWin.XMLHttpRequest.prototype.open;
        pageWin.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string') capturePotFromUrl(url);
            return origOpen.call(this, method, url, ...rest);
        };
    } catch (_) {}

    // 備援：從瀏覽器效能記錄中回溯已發出的 timedtext 請求
    function scanPerformanceForPot(videoId) {
        try {
            const entries = performance.getEntriesByType('resource');
            for (let i = entries.length - 1; i >= 0; i--) {
                const name = entries[i].name;
                if (name.includes('/api/timedtext') && name.includes(videoId)) {
                    capturePotFromUrl(name);
                    if (potCache.has(videoId)) return potCache.get(videoId);
                }
            }
        } catch (_) {}
        return potCache.get(videoId) || null;
    }

    // 若尚未捕獲 pot，自動短暫觸發一次播放器 CC 按鈕以取得金鑰
    async function ensurePot(videoId, setStatus) {
        let info = potCache.get(videoId) || scanPerformanceForPot(videoId);
        if (info) return info;

        const ccBtn = document.querySelector('.ytp-subtitles-button');
        if (!ccBtn) return null;

        setStatus('正在自動獲取字幕驗證金鑰 (pot)...');
        const wasPressed = ccBtn.getAttribute('aria-pressed') === 'true';

        if (wasPressed) {
            ccBtn.click();
            await sleep(180);
            ccBtn.click();
        } else {
            ccBtn.click();
        }

        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            info = potCache.get(videoId) || scanPerformanceForPot(videoId);
            if (info) break;
            await sleep(100);
        }

        // 還原使用者原本的字幕開關狀態
        if (!wasPressed && ccBtn.getAttribute('aria-pressed') === 'true') {
            ccBtn.click();
        }

        return info || null;
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ---------------------------------------------------------
    // 2. 取得當前影片 ID 與即時字幕軌道清單
    // ---------------------------------------------------------
    function getVideoId() {
        const u = new URL(location.href);
        if (u.pathname === '/watch') return u.searchParams.get('v');
        const m = u.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    async function getPlayerResponse(videoId) {
        // 優先從即時播放器實例讀取（SPA 切影片最準確）
        try {
            const player = (pageWin.document || document).getElementById('movie_player');
            const pr = player?.getPlayerResponse?.();
            if (pr?.videoDetails?.videoId === videoId) return pr;
        } catch (_) {}

        // 次選全域初始物件
        try {
            const pr = pageWin.ytInitialPlayerResponse;
            if (pr?.videoDetails?.videoId === videoId) return pr;
        } catch (_) {}

        // 最後備援：直接拉取頁面原始碼解析
        try {
            const res = await origFetch(`https://www.youtube.com/watch?v=${videoId}`, {
                credentials: 'include'
            });
            const html = await res.text();
            const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
            if (match) return JSON.parse(match[1]);
        } catch (_) {}

        return null;
    }

    async function getVideoMetaAndTracks(videoId) {
        const pr = await getPlayerResponse(videoId);
        const title = pr?.videoDetails?.title || document.title.replace(/\s*-\s*YouTube$/, '') || videoId;
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        return { title, tracks };
    }

    // ---------------------------------------------------------
    // 3. 下載與解析字幕（支援 JSON3 與純文字 XML 備援）
    // ---------------------------------------------------------
    function buildSubtitleUrl(baseUrl, { tlang, fmt, potInfo }) {
        const u = new URL(baseUrl);
        if (fmt) u.searchParams.set('fmt', fmt);
        else u.searchParams.delete('fmt');

        if (tlang) u.searchParams.set('tlang', tlang);
        else u.searchParams.delete('tlang');

        if (potInfo?.pot) {
            u.searchParams.set('pot', potInfo.pot);
            u.searchParams.set('potc', potInfo.potc || '1');
            if (!u.searchParams.has('c')) u.searchParams.set('c', potInfo.c || 'WEB');
        }
        return u.toString();
    }

    async function fetchSubtitleText(url) {
        const res = await origFetch(url, { credentials: 'include' });
        if (res.status === 429) {
            throw new Error('HTTP 429：請求過於頻繁（自動翻譯較易觸發），請稍後再試');
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} 請求失敗`);
        }
        return await res.text();
    }

    function parseJson3(raw) {
        const data = JSON.parse(raw);
        const events = Array.isArray(data?.events) ? data.events : [];
        const cues = [];

        for (const ev of events) {
            if (!Array.isArray(ev.segs) || typeof ev.tStartMs !== 'number') continue;
            const text = ev.segs
                .map((s) => s.utf8 || '')
                .join('')
                .replace(/\r/g, '')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n{2,}/g, '\n')
                .trim();

            if (!text) continue;
            cues.push({
                startMs: ev.tStartMs,
                endMs: typeof ev.dDurationMs === 'number' ? ev.tStartMs + ev.dDurationMs : null,
                text
            });
        }

        // 修正缺少結束時間或與下一句重疊的區段（常見於自動生成字幕）
        for (let i = 0; i < cues.length; i++) {
            const nextStart = i + 1 < cues.length ? cues[i + 1].startMs : null;
            if (cues[i].endMs === null || cues[i].endMs <= cues[i].startMs) {
                cues[i].endMs = nextStart && nextStart > cues[i].startMs ? nextStart : cues[i].startMs + 2500;
            } else if (nextStart && cues[i].endMs > nextStart && nextStart > cues[i].startMs) {
                cues[i].endMs = nextStart;
            }
        }
        return cues;
    }

    function decodeEntities(str) {
        return str
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/"/g, '"')
            .replace(/'|'/g, "'")
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/&/g, '&');
    }

    // 避免觸發 YouTube Trusted Types CSP，不使用 DOMParser，改用純正規解析 XML 備援
    function parseXmlFallback(raw) {
        const cues = [];
        const textTagRe = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
        let m;
        while ((m = textTagRe.exec(raw)) !== null) {
            const startMs = Math.round(parseFloat(m[1]) * 1000);
            const durMs = m[2] ? Math.round(parseFloat(m[2]) * 1000) : 2500;
            const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
            if (text) cues.push({ startMs, endMs: startMs + durMs, text });
        }
        if (cues.length > 0) return cues;

        const pTagRe = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
        while ((m = pTagRe.exec(raw)) !== null) {
            const startMs = parseInt(m[1], 10);
            const durMs = m[2] ? parseInt(m[2], 10) : 2500;
            const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).trim();
            if (text) cues.push({ startMs, endMs: startMs + durMs, text });
        }
        return cues;
    }

    function formatSrtTime(ms) {
        const total = Math.max(0, Math.floor(ms));
        const h = String(Math.floor(total / 3600000)).padStart(2, '0');
        const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
        const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
        const msPart = String(total % 1000).padStart(3, '0');
        return `${h}:${m}:${s},${msPart}`;
    }

    function toSrt(cues) {
        return cues
            .map((c, idx) => `${idx + 1}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`)
            .join('\n\n') + '\n';
    }

    function toTxt(cues) {
        return cues.map((c) => c.text.replace(/\n+/g, ' ')).join('\n') + '\n';
    }

    function sanitizeFilename(name) {
        return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
    }

    function downloadFile(content, filename) {
        const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function handleDownload(track, tlang, format, title, videoId, setStatus) {
        const needsPot = track.baseUrl.includes('exp=xpe');
        let potInfo = potCache.get(videoId) || scanPerformanceForPot(videoId);

        if (!potInfo && needsPot) {
            potInfo = await ensurePot(videoId, setStatus);
        }

        setStatus('正在下載字幕...');
        let raw = await fetchSubtitleText(
            buildSubtitleUrl(track.baseUrl, { tlang, fmt: 'json3', potInfo })
        );

        // 若未帶 pot 返回空內容，補抓一次 pot 並重試
        if (!raw.trim() && !potInfo) {
            potInfo = await ensurePot(videoId, setStatus);
            if (potInfo) {
                setStatus('已取得金鑰，重新下載中...');
                raw = await fetchSubtitleText(
                    buildSubtitleUrl(track.baseUrl, { tlang, fmt: 'json3', potInfo })
                );
            }
        }

        let cues = [];
        if (raw.trim().startsWith('{')) {
            cues = parseJson3(raw);
        } else {
            // JSON3 失敗時改用 XML 格式重試
            const xmlRaw = await fetchSubtitleText(
                buildSubtitleUrl(track.baseUrl, { tlang, fmt: null, potInfo })
            );
            if (xmlRaw.trim()) cues = parseXmlFallback(xmlRaw);
        }

        if (!cues.length) {
            throw new Error('伺服器返回空字幕（請先手動開關播放器 CC 字幕後再點下載）');
        }

        const langTag = tlang ? `${track.languageCode}_to_${tlang}` : track.languageCode;
        const output = format === 'srt' ? toSrt(cues) : toTxt(cues);
        const filename = `${sanitizeFilename(title)} [${langTag}].${format}`;
        downloadFile(output, filename);
        setStatus(`下載完成（共 ${cues.length} 句）`, '#4ade80');
    }

    // ---------------------------------------------------------
    // 4. 介面建置（純 DOM API，完全相容 YouTube Trusted Types）
    // ---------------------------------------------------------
    function injectStyles() {
        if (document.getElementById('yt-sub-pot-style')) return;
        const style = document.createElement('style');
        style.id = 'yt-sub-pot-style';
        style.textContent = `
            #yt-sub-pot-fab {
                position: fixed;
                right: 18px;
                bottom: 74px;
                z-index: 2147483640;
                height: 38px;
                padding: 0 14px;
                border-radius: 999px;
                border: 1px solid rgba(255,255,255,0.18);
                background: rgba(24,24,24,0.88);
                color: #f1f1f1;
                font: 600 13px/1 system-ui, -apple-system, sans-serif;
                cursor: pointer;
                backdrop-filter: blur(12px);
                box-shadow: 0 6px 20px rgba(0,0,0,0.4);
                display: none;
                align-items: center;
                gap: 6px;
                transition: transform 0.15s ease, background 0.15s ease;
            }
            #yt-sub-pot-fab:hover {
                background: rgba(42,42,42,0.95);
                transform: translateY(-1px);
            }
            #yt-sub-pot-panel {
                position: fixed;
                right: 18px;
                bottom: 122px;
                z-index: 2147483641;
                width: 300px;
                padding: 14px;
                border-radius: 14px;
                border: 1px solid rgba(255,255,255,0.16);
                background: rgba(24,24,24,0.94);
                color: #f1f1f1;
                font: 13px/1.4 system-ui, -apple-system, sans-serif;
                backdrop-filter: blur(16px);
                box-shadow: 0 12px 36px rgba(0,0,0,0.55);
                display: none;
                flex-direction: column;
                gap: 10px;
                box-sizing: border-box;
            }
            #yt-sub-pot-panel.open { display: flex; }
            .yt-sub-pot-head {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: 700;
                font-size: 14px;
            }
            .yt-sub-pot-close {
                background: none;
                border: none;
                color: #aaa;
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
                line-height: 1;
            }
            .yt-sub-pot-close:hover { color: #fff; }
            .yt-sub-pot-label {
                font-size: 11px;
                color: #aaa;
                margin-bottom: 4px;
                display: block;
            }
            .yt-sub-pot-select {
                width: 100%;
                padding: 7px 8px;
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.16);
                background: #1a1a1a;
                color: #f1f1f1;
                font-size: 13px;
                outline: none;
            }
            .yt-sub-pot-actions {
                display: flex;
                gap: 8px;
                margin-top: 2px;
            }
            .yt-sub-pot-btn {
                flex: 1;
                padding: 8px 10px;
                border-radius: 8px;
                border: none;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: opacity 0.15s;
            }
            .yt-sub-pot-btn:disabled { opacity: 0.45; cursor: not-allowed; }
            .yt-sub-pot-btn.srt { background: #ff0033; color: #fff; }
            .yt-sub-pot-btn.txt { background: rgba(255,255,255,0.14); color: #fff; }
            .yt-sub-pot-btn:not(:disabled):hover { opacity: 0.88; }
            .yt-sub-pot-status {
                font-size: 12px;
                color: #bbb;
                min-height: 16px;
                word-break: break-word;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function createUI() {
        if (document.getElementById('yt-sub-pot-fab')) return;
        injectStyles();

        const fab = document.createElement('button');
        fab.id = 'yt-sub-pot-fab';
        fab.type = 'button';
        fab.textContent = 'CC 字幕';

        const panel = document.createElement('div');
        panel.id = 'yt-sub-pot-panel';

        const head = document.createElement('div');
        head.className = 'yt-sub-pot-head';
        const titleSpan = document.createElement('span');
        titleSpan.textContent = '下載 YouTube 字幕';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'yt-sub-pot-close';
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        head.append(titleSpan, closeBtn);

        const trackWrap = document.createElement('div');
        const trackLabel = document.createElement('label');
        trackLabel.className = 'yt-sub-pot-label';
        trackLabel.textContent = '字幕軌道';
        const trackSelect = document.createElement('select');
        trackSelect.className = 'yt-sub-pot-select';
        trackWrap.append(trackLabel, trackSelect);

        const transWrap = document.createElement('div');
        const transLabel = document.createElement('label');
        transLabel.className = 'yt-sub-pot-label';
        transLabel.textContent = '自動翻譯（可選）';
        const transSelect = document.createElement('select');
        transSelect.className = 'yt-sub-pot-select';
        [
            ['', '不翻譯（原字幕）'],
            ['zh-Hant', '繁體中文'],
            ['zh-Hans', '簡體中文'],
            ['en', 'English'],
            ['ja', '日本語']
        ].forEach(([val, text]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = text;
            transSelect.appendChild(opt);
        });
        transWrap.append(transLabel, transSelect);

        const actions = document.createElement('div');
        actions.className = 'yt-sub-pot-actions';
        const btnSrt = document.createElement('button');
        btnSrt.type = 'button';
        btnSrt.className = 'yt-sub-pot-btn srt';
        btnSrt.textContent = '下載 SRT';
        const btnTxt = document.createElement('button');
        btnTxt.type = 'button';
        btnTxt.className = 'yt-sub-pot-btn txt';
        btnTxt.textContent = '下載 TXT';
        actions.append(btnSrt, btnTxt);

        const statusEl = document.createElement('div');
        statusEl.className = 'yt-sub-pot-status';

        panel.append(head, trackWrap, transWrap, actions, statusEl);
        document.body.append(fab, panel);

        let currentMeta = { videoId: null, title: '', tracks: [] };

        function setStatus(msg, color = '#bbb') {
            statusEl.textContent = msg;
            statusEl.style.color = color;
        }

        async function loadTracks() {
            const videoId = getVideoId();
            trackSelect.replaceChildren();
            btnSrt.disabled = true;
            btnTxt.disabled = true;

            if (!videoId) {
                setStatus('找不到當前影片 ID');
                return;
            }

            setStatus('正在讀取字幕清單...');
            const { title, tracks } = await getVideoMetaAndTracks(videoId);
            currentMeta = { videoId, title, tracks };

            if (!tracks.length) {
                const opt = document.createElement('option');
                opt.textContent = '此影片無可用字幕';
                trackSelect.appendChild(opt);
                setStatus('此影片沒有提供字幕軌道', '#f87171');
                return;
            }

            tracks.forEach((tr, idx) => {
                const opt = document.createElement('option');
                opt.value = String(idx);
                const name = tr.name?.simpleText || tr.name?.runs?.map((r) => r.text).join('') || tr.languageCode;
                const tag = tr.kind === 'asr' ? ' [自動生成]' : '';
                opt.textContent = `${name} (${tr.languageCode})${tag}`;
                trackSelect.appendChild(opt);
            });

            btnSrt.disabled = false;
            btnTxt.disabled = false;
            const hasPot = !!(potCache.get(videoId) || scanPerformanceForPot(videoId));
            setStatus(hasPot ? '已就緒（已捕獲 pot 金鑰）' : '已就緒（下載時將自動取得金鑰）');
        }

        async function onDownloadClick(format) {
            const idx = Number(trackSelect.value);
            const track = currentMeta.tracks[idx];
            if (!track) return;

            btnSrt.disabled = true;
            btnTxt.disabled = true;
            try {
                await handleDownload(
                    track,
                    transSelect.value,
                    format,
                    currentMeta.title,
                    currentMeta.videoId,
                    setStatus
                );
            } catch (err) {
                setStatus(err.message || '下載失敗', '#f87171');
            } finally {
                btnSrt.disabled = false;
                btnTxt.disabled = false;
            }
        }

        fab.addEventListener('click', () => {
            const willOpen = !panel.classList.contains('open');
            panel.classList.toggle('open', willOpen);
            if (willOpen) loadTracks();
        });

        closeBtn.addEventListener('click', () => panel.classList.remove('open'));
        btnSrt.addEventListener('click', () => onDownloadClick('srt'));
        btnTxt.addEventListener('click', () => onDownloadClick('txt'));

        function syncVisibility() {
            const show = !!getVideoId();
            fab.style.display = show ? 'inline-flex' : 'none';
            if (!show) {
                panel.classList.remove('open');
            } else if (panel.classList.contains('open')) {
                loadTracks();
            }
        }

        window.addEventListener('yt-navigate-finish', syncVisibility);
        window.addEventListener('popstate', syncVisibility);
        syncVisibility();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI, { once: true });
    } else {
        createUI();
    }
})();