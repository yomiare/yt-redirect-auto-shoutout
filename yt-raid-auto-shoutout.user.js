// ==UserScript==
// @name         YouTube Raid Auto Shoutout
// @namespace    https://github.com/yomiare/yt-redirect-auto-shoutout
// @version      1.0.1
// @description  YouTubeライブ配信中にライブリダイレクト（レイド）を検知し、紹介元チャンネルのURL（https://www.youtube.com/@...）をチャット欄へ自動投稿します。
// @author       yomiare
// @match        https://www.youtube.com/live_chat*
// @match        https://studio.youtube.com/live_chat*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      www.youtube.com
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  if (pageWindow.__ytRaidAutoShoutoutUserscriptLoaded) {
    return;
  }
  pageWindow.__ytRaidAutoShoutoutUserscriptLoaded = true;

  const STORAGE_SETTINGS_KEY = 'yt_raid_settings';
  const STORAGE_HISTORY_KEY = 'yt_raid_history';
  const MAX_HISTORY_ITEMS = 50;
  const MAX_CHAT_LENGTH = 200;
  const LIVE_CHAT_ENDPOINT = '/youtubei/v1/live_chat/get_live_chat';
  const REDIRECT_TEXT_PATTERN = /(redirected|sent viewers|リダイレクト|レイド|視聴者を.*送|が参加しました)/i;
  const SAMPLE_CHANNEL = 'サンプル配信者';
  const SAMPLE_URL = 'https://www.youtube.com/@YouTube';

  const DEFAULT_SETTINGS = {
    enabled: true,
    template: '{channel} さん、レイドありがとうございます！ {url}',
    delaySeconds: 3,
    cooldownSeconds: 180,
    dryRun: false
  };

  const recentRaids = new Map();
  const handleCache = new Map();
  const raidQueue = [];
  let isProcessingQueue = false;
  let modalRefs = null;
  let toastTimer = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getSettings() {
    const saved = GM_getValue(STORAGE_SETTINGS_KEY, {});
    return {
      enabled: saved.enabled !== undefined ? Boolean(saved.enabled) : DEFAULT_SETTINGS.enabled,
      template:
        typeof saved.template === 'string' && saved.template.trim()
          ? saved.template
          : DEFAULT_SETTINGS.template,
      delaySeconds:
        saved.delaySeconds !== undefined
          ? Math.min(60, Math.max(0, Number(saved.delaySeconds) || 0))
          : DEFAULT_SETTINGS.delaySeconds,
      cooldownSeconds:
        saved.cooldownSeconds !== undefined
          ? Math.min(600, Math.max(5, Number(saved.cooldownSeconds) || 180))
          : DEFAULT_SETTINGS.cooldownSeconds,
      dryRun: saved.dryRun !== undefined ? Boolean(saved.dryRun) : DEFAULT_SETTINGS.dryRun
    };
  }

  function saveSettings(next) {
    GM_setValue(STORAGE_SETTINGS_KEY, next);
  }

  function getHistory() {
    const list = GM_getValue(STORAGE_HISTORY_KEY, []);
    return Array.isArray(list) ? list : [];
  }

  function appendHistory(entry) {
    const updated = [entry, ...getHistory()].slice(0, MAX_HISTORY_ITEMS);
    GM_setValue(STORAGE_HISTORY_KEY, updated);
    if (modalRefs && modalRefs.overlay.classList.contains('open')) {
      renderHistory(updated);
    }
    return updated;
  }

  function clearHistory() {
    GM_setValue(STORAGE_HISTORY_KEY, []);
    if (modalRefs) {
      renderHistory([]);
    }
  }

  function isHandleUrl(url) {
    return typeof url === 'string' && /^https:\/\/www\.youtube\.com\/@[^/?#]+/.test(url);
  }

  function extractHandleFromHtml(html) {
    if (typeof html !== 'string' || !html) return null;

    const canonicalMatch = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["'](https:\/\/www\.youtube\.com\/@[^"']+)["']/i
    );
    if (canonicalMatch?.[1]) return canonicalMatch[1];

    const vanityMatch = html.match(
      /"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(@[^"\\]+)"/
    );
    if (vanityMatch?.[1]) return `https://www.youtube.com/${vanityMatch[1]}`;

    const baseUrlMatch = html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"\\]+)"/);
    if (baseUrlMatch?.[1]) return `https://www.youtube.com/${baseUrlMatch[1]}`;  return null; }  function resolveChannelHandle(raid) { if (isHandleUrl(raid.channelUrl)) { return Promise.resolve(raid.channelUrl); }  const cacheKey = raid.browseId \vert{}\vert{} raid.channelUrl; if (cacheKey && handleCache.has(cacheKey)) { return Promise.resolve(handleCache.get(cacheKey)); }  const targetUrl = raid.browseId ? `https://www.youtube.com/channel/${encodeURIComponent(raid.browseId)}`
      : raid.channelUrl;

    if (!targetUrl) {
      return Promise.resolve('');
    }

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: targetUrl,
        anonymous: true,
        headers: { 'Accept-Language': 'ja,en;q=0.9' },
        onload: (res) => {
          try {
            if (res.finalUrl && isHandleUrl(res.finalUrl)) {
              if (cacheKey) handleCache.set(cacheKey, res.finalUrl);
              resolve(res.finalUrl);
              return;
            }
            const handleUrl = extractHandleFromHtml(res.responseText);
            if (handleUrl) {
              if (cacheKey) handleCache.set(cacheKey, handleUrl);
              resolve(handleUrl);
              return;
            }
          } catch {
            // Fallback
          }
          resolve(targetUrl);
        },
        onerror: () => resolve(targetUrl),
        ontimeout: () => resolve(targetUrl)
      });
    });
  }

  function extractRunsText(runs) {
    if (!Array.isArray(runs)) return '';
    return runs.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('').trim();
  }

  function findBrowseEndpoint(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return null;

    if (obj.browseEndpoint && typeof obj.browseEndpoint === 'object') {
      const { browseId, canonicalBaseUrl } = obj.browseEndpoint;
      if (browseId || canonicalBaseUrl) {
        return {
          browseId: browseId || null,
          canonicalBaseUrl: canonicalBaseUrl || null
        };
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findBrowseEndpoint(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(obj)) {
      const found = findBrowseEndpoint(obj[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  function buildChannelUrl(canonicalBaseUrl, browseId) {
    if (typeof canonicalBaseUrl === 'string' && canonicalBaseUrl.trim()) {
      const cleanPath = canonicalBaseUrl.trim();
      if (cleanPath.startsWith('http://') || cleanPath.startsWith('https://')) {
        return cleanPath;
      }
      return `https://www.youtube.com${cleanPath.startsWith('/') ? '' : '/'}${cleanPath}`;
    }
    if (typeof browseId === 'string' && browseId.trim()) {
      return `https://www.youtube.com/channel/${browseId.trim()}`; } return null; }  function extractChannelNameFromRuns(runs) { if (!Array.isArray(runs) \vert{}\vert{} runs.length === 0) return ''; const boldOrLinkedRun = runs.find( (run) => typeof run?.text === 'string' && run.text.trim() && (run.bold \vert{}\vert{} run.navigationEndpoint?.browseEndpoint) ); if (boldOrLinkedRun) return boldOrLinkedRun.text.trim(); return runs[0]?.text?.trim() \vert{}\vert{} ''; }  function parseBannerRedirectRenderer(renderer) { if (!renderer \vert{}\vert{} typeof renderer !== 'object') return null;  const runs = renderer.bannerMessage?.runs \vert{}\vert{} renderer.message?.runs \vert{}\vert{} []; const fullText = extractRunsText(runs); const endpoint = findBrowseEndpoint(renderer.inlineActionButton) \vert{}\vert{} findBrowseEndpoint(renderer.bannerMessage) \vert{}\vert{} findBrowseEndpoint(renderer);  const browseId = endpoint?.browseId \vert{}\vert{} null; const canonicalBaseUrl = endpoint?.canonicalBaseUrl \vert{}\vert{} null; const channelUrl = buildChannelUrl(canonicalBaseUrl, browseId);  if (!channelUrl && !fullText) return null;  const channelName = extractChannelNameFromRuns(runs) \vert{}\vert{} (canonicalBaseUrl?.startsWith('/@') ? canonicalBaseUrl.slice(1) : 'チャンネル');  return { channelName, channelUrl, browseId, canonicalBaseUrl, rawText: fullText, detectedVia: 'liveChatBannerRedirectRenderer', timestamp: Date.now() }; }  function parseEngagementMessageRenderer(renderer) { if (!renderer \vert{}\vert{} typeof renderer !== 'object') return null;  const runs = renderer.message?.runs \vert{}\vert{} []; const fullText = extractRunsText(runs); const iconType = renderer.icon?.iconType \vert{}\vert{} '';  const isRedirect = iconType.includes('REDIRECT') \vert{}\vert{} iconType.includes('RAID') \vert{}\vert{} REDIRECT_TEXT_PATTERN.test(fullText);  if (!isRedirect) return null;  const endpoint = findBrowseEndpoint(renderer); if (!endpoint) return null;  const channelUrl = buildChannelUrl(endpoint.canonicalBaseUrl, endpoint.browseId); if (!channelUrl) return null;  const channelName = extractChannelNameFromRuns(runs) \vert{}\vert{} (endpoint.canonicalBaseUrl?.startsWith('/@') ? endpoint.canonicalBaseUrl.slice(1) : 'チャンネル');  return { channelName, channelUrl, browseId: endpoint.browseId, canonicalBaseUrl: endpoint.canonicalBaseUrl, rawText: fullText, detectedVia: 'liveChatViewerEngagementMessageRenderer', timestamp: Date.now() }; }  function inspectActions(actions) { if (!Array.isArray(actions)) return;  for (const action of actions) { if (!action \vert{}\vert{} typeof action !== 'object') continue;  const bannerRenderer = action.addBannerToLiveChatCommand?.bannerRenderer?.liveChatBannerRenderer; if (bannerRenderer?.contents?.liveChatBannerRedirectRenderer) { const parsed = parseBannerRedirectRenderer( bannerRenderer.contents.liveChatBannerRedirectRenderer ); if (parsed) enqueueRaid(parsed); }  const chatItem = action.addChatItemAction?.item; if (chatItem?.liveChatViewerEngagementMessageRenderer) { const parsed = parseEngagementMessageRenderer( chatItem.liveChatViewerEngagementMessageRenderer ); if (parsed) enqueueRaid(parsed); }  if (chatItem?.liveChatBannerRedirectRenderer) { const parsed = parseBannerRedirectRenderer(chatItem.liveChatBannerRedirectRenderer); if (parsed) enqueueRaid(parsed); } } }  function inspectLiveChatPayload(data) { if (!data \vert{}\vert{} typeof data !== 'object') return;  const continuationActions = data.continuationContents?.liveChatContinuation?.actions; if (Array.isArray(continuationActions)) inspectActions(continuationActions);  const initialActions = data.contents?.liveChatRenderer?.actions; if (Array.isArray(initialActions)) inspectActions(initialActions); }  function hookNetworkAndInitialData() { const originalFetch = pageWindow.fetch; if (typeof originalFetch === 'function') { pageWindow.fetch = async function (...args) { const response = await originalFetch.apply(this, args); try { const requestUrl = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : ''; if (requestUrl.includes(LIVE_CHAT_ENDPOINT)) { response .clone() .json() .then((json) => inspectLiveChatPayload(json)) .catch(() => {}); } } catch { // Ignore } return response; }; }  const XHR = pageWindow.XMLHttpRequest; if (XHR?.prototype) { const originalOpen = XHR.prototype.open; const originalSend = XHR.prototype.send;  XHR.prototype.open = function (method, url, ...rest) { this.__ytRaidUrl = typeof url === 'string' ? url : String(url \vert{}\vert{} ''); return originalOpen.call(this, method, url, ...rest); };  XHR.prototype.send = function (...args) { if (this.__ytRaidUrl && this.__ytRaidUrl.includes(LIVE_CHAT_ENDPOINT)) { this.addEventListener('load', function () { try { if (typeof this.responseText === 'string' && this.responseText.length > 0) { inspectLiveChatPayload(JSON.parse(this.responseText)); } } catch { // Ignore } }); } return originalSend.apply(this, args); }; }  try { if (pageWindow.ytInitialData) { inspectLiveChatPayload(pageWindow.ytInitialData); } } catch { // Ignore } }  function extractRaidFromBannerElement(bannerEl) { if (!bannerEl) return null;  const anchor = bannerEl.querySelector('a[href*="/@"], a[href*="/channel/"]'); let channelUrl = null; let browseId = null;  if (anchor) { const href = anchor.getAttribute('href') \vert{}\vert{} ''; if (href.startsWith('http://') \vert{}\vert{} href.startsWith('https://')) { channelUrl = href; } else if (href.startsWith('/')) { channelUrl = `https://www.youtube.com${href}`;
      }
      const channelMatch = href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
      if (channelMatch?.[1]) browseId = channelMatch[1];
    }

    const boldEl = bannerEl.querySelector(
      'yt-formatted-string, .yt-core-attributed-string, strong, b'
    );
    const channelName =
      anchor?.textContent?.trim() || boldEl?.textContent?.trim() || 'チャンネル';

    if (!channelUrl && !browseId) return null;

    return {
      channelName,
      channelUrl,
      browseId,
      detectedVia: 'domMutationObserver',
      timestamp: Date.now()
    };
  }

  function setupDomObserver() {
    if (!document.body) return;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;

          const redirectBanner = node.matches('yt-live-chat-banner-redirect-renderer')
            ? node
            : node.querySelector('yt-live-chat-banner-redirect-renderer');

          if (redirectBanner) {
            const parsed = extractRaidFromBannerElement(redirectBanner);
            if (parsed) enqueueRaid(parsed);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function formatShoutoutMessage(template, channelName, url) {
    let message = template
      .replace(/\{channel\}/gi, channelName || '配信者')
      .replace(/\{url\}/gi, url || '');

    if (url && !message.includes(url)) {
      message = `${message.trim()}${url}`;
    }

    message = message.replace(/\s+/g, ' ').trim();

    if (message.length > MAX_CHAT_LENGTH && url && message.includes(url)) {
      const withoutUrl = message.replace(url, '').trim();
      const available = Math.max(0, MAX_CHAT_LENGTH - url.length - 1);
      const truncatedPrefix = withoutUrl.slice(0, available).trim();
      message = truncatedPrefix ? `${truncatedPrefix}${url}` : url.slice(0, MAX_CHAT_LENGTH);
    } else if (message.length > MAX_CHAT_LENGTH) {
      message = message.slice(0, MAX_CHAT_LENGTH);
    }

    return message;
  }

  function findChatInputElement() {
    const selectors = [
      'yt-live-chat-message-input-renderer yt-live-chat-text-input-field-renderer #input[contenteditable="true"]',
      'yt-live-chat-text-input-field-renderer #input[contenteditable="true"]',
      '#chat-messages #input[contenteditable="true"]',
      'div#input[contenteditable="true"]'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function findSendButtonElement() {
    const selectors = [
      'yt-live-chat-message-input-renderer #send-button yt-button-shape button',
      'yt-live-chat-message-input-renderer #send-button button',
      '#send-button yt-button-shape button',
      '#send-button button',
      '#send-button'
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  async function postChatMessage(text) {
    const inputEl = findChatInputElement();
    if (!inputEl) {
      return {
        ok: false,
        error: 'チャット入力欄が見つかりません（未ログインまたはチャット無効）。'
      };
    }

    inputEl.focus();

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }

    if (!inserted || inputEl.textContent.trim() !== text.trim()) {
      inputEl.textContent = text;
      inputEl.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: 'insertText',
          data: text
        })
      );
    } else {
      inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    }

    await sleep(200);

    const sendBtn = findSendButtonElement();
    if (!sendBtn) {
      return { ok: false, error: '送信ボタンが見つかりません。' };
    }

    if (sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: '送信ボタンが無効状態です（文字数制限または権限不足）。' };
    }

    sendBtn.click();
    return { ok: true };
  }

  // URL解決後の正規化URL・ID・チャンネル名のすべてで二重投稿を防止
  function isDuplicateRaid(raid, resolvedUrl, cooldownSeconds) {
    const keys = [raid.browseId, resolvedUrl, raid.channelUrl, raid.channelName]
      .filter((v) => typeof v === 'string' && v.trim() && v !== 'チャンネル')
      .map((v) => v.trim().toLowerCase());

    if (keys.length === 0) return false;

    const now = Date.now();
    for (const key of keys) {
      const lastSeen = recentRaids.get(key);
      if (lastSeen && now - lastSeen < cooldownSeconds * 1000) {
        return true;
      }
    }

    for (const key of keys) {
      recentRaids.set(key, now);
    }

    for (const [entryKey, ts] of recentRaids.entries()) {
      if (now - ts > Math.max(cooldownSeconds, 60) * 2000) {
        recentRaids.delete(entryKey);
      }
    }

    return false;
  }

  async function processRaid(raid) {
    const settings = getSettings();

    if (!raid.isTest && !settings.enabled) {
      return { ok: false, error: '自動投稿は無効になっています。' };
    }

    const resolvedUrl = await resolveChannelHandle(raid);

    if (!raid.isTest && isDuplicateRaid(raid, resolvedUrl, settings.cooldownSeconds)) {
      return { ok: true, skipped: true };
    }

    const channelName = raid.channelName || '配信者';
    const messageText = formatShoutoutMessage(settings.template, channelName, resolvedUrl);

    if (!raid.isTest && settings.delaySeconds > 0) {
      await sleep(settings.delaySeconds * 1000);
    }

    if (settings.dryRun && !raid.forceSend) {
      appendHistory({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        channelName,
        channelUrl: resolvedUrl,
        message: messageText,
        status: 'dry-run'
      });
      return { ok: true, dryRun: true, message: messageText };
    }

    const result = await postChatMessage(messageText);
    appendHistory({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      channelName,
      channelUrl: resolvedUrl,
      message: messageText,
      status: result.ok ? 'posted' : 'failed',
      error: result.error || null
    });

    return { ...result, message: messageText, url: resolvedUrl };
  }

  async function drainQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    try {
      while (raidQueue.length > 0) {
        const nextRaid = raidQueue.shift();
        await processRaid(nextRaid);
        await sleep(500);
      }
    } finally {
      isProcessingQueue = false;
    }
  }

  function enqueueRaid(raid) {
    raidQueue.push(raid);
    drainQueue();
  }

  async function runTestShoutout() {
    const settings = getSettings();
    return await processRaid({
      channelName: SAMPLE_CHANNEL,
      channelUrl: SAMPLE_URL,
      browseId: null,
      isTest: true,
      forceSend: !settings.dryRun,
      timestamp: Date.now()
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function injectStyles() {
    if (document.getElementById('yras-styles')) return;
    const style = document.createElement('style');
    style.id = 'yras-styles';
    style.textContent = `
      #yras-launcher {
        position: fixed;
        right: 48px;
        top: 10px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 999px;
        border: 1px solid #3f3f46;
        background: rgba(15, 15, 18, 0.88);
        color: #f1f1f4;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic", sans-serif;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        transition: border-color 0.15s, background-color 0.15s;
      }
      #yras-launcher:hover {
        border-color: #ff0033;
        background: #1a1a20;
      }
      #yras-launcher-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22c55e;
      }
      #yras-launcher-dot.off {
        background: #71717a;
      }
      #yras-overlay {
        position: fixed;
        inset: 0;
        z-index: 100000;
        background: rgba(0, 0, 0, 0.65);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic", sans-serif;
      }
      #yras-overlay.open {
        display: flex;
      }
      #yras-modal {
        width: 100%;
        max-width: 350px;
        max-height: 92vh;
        overflow-y: auto;
        background: #0f0f12;
        color: #f1f1f4;
        border: 1px solid #2f2f3a;
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.6);
        font-size: 12px;
      }
      .yras-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        background: #1a1a20;
        border-bottom: 1px solid #2f2f3a;
      }
      .yras-title-group {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .yras-badge-live {
        background: #ff0033;
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 5px;
        border-radius: 4px;
      }
      .yras-title {
        font-size: 13px;
        font-weight: 700;
      }
      .yras-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .yras-close {
        background: none;
        border: none;
        color: #9ca3af;
        font-size: 16px;
        cursor: pointer;
        padding: 0 4px;
      }
      .yras-close:hover {
        color: #fff;
      }
      .yras-body {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 9px;
      }
      .yras-card {
        background: #1a1a20;
        border: 1px solid #2f2f3a;
        border-radius: 8px;
        padding: 9px 10px;
      }
      .yras-field-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 5px;
      }
      .yras-label {
        font-weight: 600;
        font-size: 12px;
      }
      .yras-char-count {
        font-size: 11px;
        color: #9ca3af;
      }
      .yras-char-count.over {
        color: #ef4444;
