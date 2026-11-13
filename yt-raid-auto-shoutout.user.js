// ==UserScript==
// @name         YouTube Raid Auto Shoutout
// @namespace    https://github.com/yt-raid-auto-shoutout
// @version      1.0.0
// @description  YouTubeライブ配信中にライブリダイレクト（レイド）を検知し、紹介元チャンネルのURL（https://www.youtube.com/@...）をチャット欄へ自動投稿します。
// @author       yt-raid-auto-shoutout
// @match        https://www.youtube.com/live_chat*
// @match        https://studio.youtube.com/live_chat*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      www.youtube.com
// @run-at       document-idle
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
  const REDIRECT_TEXT_PATTERN = /(redirected|sent viewers|リダイレクト|レイド|視聴者を.*送)/i;
  const SAMPLE_CHANNEL = 'サンプル配信者';
  const SAMPLE_URL = 'https://www.youtube.com/@YouTube';

  const DEFAULT_SETTINGS = {
    enabled: true,
    template: '{channel} さん、レイドありがとうございます！ {url}',
    delaySeconds: 3,
    cooldownSeconds: 30,
    dryRun: false
  };

  const recentRaids = new Map();
  const handleCache = new Map();
  const raidQueue = [];
  let isProcessingQueue = false;
  let modalRefs = null;
  let toastTimer = null;

  // ---------------------------------------------------------------------------
  // Utilities & Storage
  // ---------------------------------------------------------------------------

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
          ? Math.min(600, Math.max(5, Number(saved.cooldownSeconds) || 30))
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

  // ---------------------------------------------------------------------------
  // @handle URL Resolution (CORS-free via GM_xmlhttpRequest)
  // ---------------------------------------------------------------------------

  function isHandleUrl(url) {
    return typeof url === 'string' && /^https:\/\/www\.youtube\.com\/@[^/?#]+/.test(url);
  }

  function extractHandleFromHtml(html) {
    if (typeof html !== 'string' || !html) return null;

    const canonicalMatch = html.match(
      /<link[^>]+rel=["']canonical["'][^>]+href=["'](https:\/\/www\.youtube\.com\/@[^"']+)["']/i
    );
    if (canonicalMatch?.[1]) {
      return canonicalMatch[1];
    }

    const vanityMatch = html.match(
      /"vanityChannelUrl"\s*:\s*"https?:\/\/www\.youtube\.com\/(@[^"\\]+)"/
    );
    if (vanityMatch?.[1]) {
      return `https://www.youtube.com/${vanityMatch[1]}`;
    }

    const baseUrlMatch = html.match(/"canonicalBaseUrl"\s*:\s*"\/(@[^"\\]+)"/);
    if (baseUrlMatch?.[1]) {
      return `https://www.youtube.com/${baseUrlMatch[1]}`;
    }

    return null;
  }

  function resolveChannelHandle(raid) {
    if (isHandleUrl(raid.channelUrl)) {
      return Promise.resolve(raid.channelUrl);
    }

    const cacheKey = raid.browseId || raid.channelUrl;
    if (cacheKey && handleCache.has(cacheKey)) {
      return Promise.resolve(handleCache.get(cacheKey));
    }

    const targetUrl = raid.browseId
      ? `https://www.youtube.com/channel/${encodeURIComponent(raid.browseId)}`
      : raid.channelUrl;

    if (!targetUrl) {
      return Promise.resolve('');
    }

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: targetUrl,
        anonymous: true,
        headers: {
          'Accept-Language': 'ja,en;q=0.9'
        },
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
            // Fallback below
          }
          resolve(targetUrl);
        },
        onerror: () => resolve(targetUrl),
        ontimeout: () => resolve(targetUrl)
      });
    });
  }

  // ---------------------------------------------------------------------------
  // InnerTube Payload Inspection (fetch / XHR / ytInitialData)
  // ---------------------------------------------------------------------------

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
      return `https://www.youtube.com/channel/${browseId.trim()}`;
    }
    return null;
  }

  function extractChannelNameFromRuns(runs) {
    if (!Array.isArray(runs) || runs.length === 0) return '';
    const boldOrLinkedRun = runs.find(
      (run) =>
        typeof run?.text === 'string' &&
        run.text.trim() &&
        (run.bold || run.navigationEndpoint?.browseEndpoint)
    );
    if (boldOrLinkedRun) {
      return boldOrLinkedRun.text.trim();
    }
    return runs[0]?.text?.trim() || '';
  }

  function parseBannerRedirectRenderer(renderer) {
    if (!renderer || typeof renderer !== 'object') return null;

    const runs = renderer.bannerMessage?.runs || renderer.message?.runs || [];
    const fullText = extractRunsText(runs);
    const endpoint =
      findBrowseEndpoint(renderer.inlineActionButton) ||
      findBrowseEndpoint(renderer.bannerMessage) ||
      findBrowseEndpoint(renderer);

    const browseId = endpoint?.browseId || null;
    const canonicalBaseUrl = endpoint?.canonicalBaseUrl || null;
    const channelUrl = buildChannelUrl(canonicalBaseUrl, browseId);

    if (!channelUrl && !fullText) return null;

    const channelName =
      extractChannelNameFromRuns(runs) ||
      (canonicalBaseUrl?.startsWith('/@') ? canonicalBaseUrl.slice(1) : 'チャンネル');

    return {
      channelName,
      channelUrl,
      browseId,
      canonicalBaseUrl,
      rawText: fullText,
      detectedVia: 'liveChatBannerRedirectRenderer',
      timestamp: Date.now()
    };
  }

  function parseEngagementMessageRenderer(renderer) {
    if (!renderer || typeof renderer !== 'object') return null;

    const runs = renderer.message?.runs || [];
    const fullText = extractRunsText(runs);
    const iconType = renderer.icon?.iconType || '';

    const isRedirect =
      iconType.includes('REDIRECT') ||
      iconType.includes('RAID') ||
      REDIRECT_TEXT_PATTERN.test(fullText);

    if (!isRedirect) return null;

    const endpoint = findBrowseEndpoint(renderer);
    if (!endpoint) return null;

    const channelUrl = buildChannelUrl(endpoint.canonicalBaseUrl, endpoint.browseId);
    if (!channelUrl) return null;

    const channelName =
      extractChannelNameFromRuns(runs) ||
      (endpoint.canonicalBaseUrl?.startsWith('/@')
        ? endpoint.canonicalBaseUrl.slice(1)
        : 'チャンネル');

    return {
      channelName,
      channelUrl,
      browseId: endpoint.browseId,
      canonicalBaseUrl: endpoint.canonicalBaseUrl,
      rawText: fullText,
      detectedVia: 'liveChatViewerEngagementMessageRenderer',
      timestamp: Date.now()
    };
  }

  function inspectActions(actions) {
    if (!Array.isArray(actions)) return;

    for (const action of actions) {
      if (!action || typeof action !== 'object') continue;

      const bannerRenderer =
        action.addBannerToLiveChatCommand?.bannerRenderer?.liveChatBannerRenderer;
      if (bannerRenderer?.contents?.liveChatBannerRedirectRenderer) {
        const parsed = parseBannerRedirectRenderer(
          bannerRenderer.contents.liveChatBannerRedirectRenderer
        );
        if (parsed) enqueueRaid(parsed);
      }

      const chatItem = action.addChatItemAction?.item;
      if (chatItem?.liveChatViewerEngagementMessageRenderer) {
        const parsed = parseEngagementMessageRenderer(
          chatItem.liveChatViewerEngagementMessageRenderer
        );
        if (parsed) enqueueRaid(parsed);
      }

      if (chatItem?.liveChatBannerRedirectRenderer) {
        const parsed = parseBannerRedirectRenderer(chatItem.liveChatBannerRedirectRenderer);
        if (parsed) enqueueRaid(parsed);
      }
    }
  }

  function inspectLiveChatPayload(data) {
    if (!data || typeof data !== 'object') return;

    const continuationActions = data.continuationContents?.liveChatContinuation?.actions;
    if (Array.isArray(continuationActions)) {
      inspectActions(continuationActions);
    }

    const initialActions = data.contents?.liveChatRenderer?.actions;
    if (Array.isArray(initialActions)) {
      inspectActions(initialActions);
    }
  }

  function hookNetworkAndInitialData() {
    const originalFetch = pageWindow.fetch;
    if (typeof originalFetch === 'function') {
      pageWindow.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try {
          const requestUrl =
            typeof args[0] === 'string'
              ? args[0]
              : args[0] instanceof Request
                ? args[0].url
                : '';
          if (requestUrl.includes(LIVE_CHAT_ENDPOINT)) {
            response
              .clone()
              .json()
              .then((json) => inspectLiveChatPayload(json))
              .catch(() => {});
          }
        } catch {
          // Ignore inspection errors
        }
        return response;
      };
    }

    const XHR = pageWindow.XMLHttpRequest;
    if (XHR?.prototype) {
      const originalOpen = XHR.prototype.open;
      const originalSend = XHR.prototype.send;

      XHR.prototype.open = function (method, url, ...rest) {
        this.__ytRaidUrl = typeof url === 'string' ? url : String(url || '');
        return originalOpen.call(this, method, url, ...rest);
      };

      XHR.prototype.send = function (...args) {
        if (this.__ytRaidUrl && this.__ytRaidUrl.includes(LIVE_CHAT_ENDPOINT)) {
          this.addEventListener('load', function () {
            try {
              if (typeof this.responseText === 'string' && this.responseText.length > 0) {
                inspectLiveChatPayload(JSON.parse(this.responseText));
              }
            } catch {
              // Ignore parse errors
            }
          });
        }
        return originalSend.apply(this, args);
      };
    }

    try {
      if (pageWindow.ytInitialData) {
        inspectLiveChatPayload(pageWindow.ytInitialData);
      }
    } catch {
      // Ignore
    }
  }

  // ---------------------------------------------------------------------------
  // DOM Fallback Observer
  // ---------------------------------------------------------------------------

  function extractRaidFromBannerElement(bannerEl) {
    if (!bannerEl) return null;

    const anchor = bannerEl.querySelector('a[href*="/@"], a[href*="/channel/"]');
    let channelUrl = null;
    let browseId = null;

    if (anchor) {
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('http://') || href.startsWith('https://')) {
        channelUrl = href;
      } else if (href.startsWith('/')) {
        channelUrl = `https://www.youtube.com${href}`;
      }
      const channelMatch = href.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
      if (channelMatch?.[1]) {
        browseId = channelMatch[1];
      }
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

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // ---------------------------------------------------------------------------
  // Chat Auto-Input & Send
  // ---------------------------------------------------------------------------

  function formatShoutoutMessage(template, channelName, url) {
    let message = template
      .replace(/\{channel\}/gi, channelName || '配信者')
      .replace(/\{url\}/gi, url || '');

    if (url && !message.includes(url)) {
      message = `${message.trim()} ${url}`;
    }

    message = message.replace(/\s+/g, ' ').trim();

    if (message.length > MAX_CHAT_LENGTH && url && message.includes(url)) {
      const withoutUrl = message.replace(url, '').trim();
      const available = Math.max(0, MAX_CHAT_LENGTH - url.length - 1);
      const truncatedPrefix = withoutUrl.slice(0, available).trim();
      message = truncatedPrefix ? `${truncatedPrefix} ${url}` : url.slice(0, MAX_CHAT_LENGTH);
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

  // ---------------------------------------------------------------------------
  // Raid Queue & Deduplication
  // ---------------------------------------------------------------------------

  function isDuplicateRaid(raid, cooldownSeconds) {
    const key = (raid.browseId || raid.channelUrl || raid.channelName || '').toLowerCase();
    if (!key) return false;

    const now = Date.now();
    const lastSeen = recentRaids.get(key);
    if (lastSeen && now - lastSeen < cooldownSeconds * 1000) {
      return true;
    }
    recentRaids.set(key, now);

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

    if (!raid.isTest && isDuplicateRaid(raid, settings.cooldownSeconds)) {
      return { ok: true, skipped: true };
    }

    const resolvedUrl = await resolveChannelHandle(raid);
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
    const res = await processRaid({
      channelName: SAMPLE_CHANNEL,
      channelUrl: SAMPLE_URL,
      browseId: null,
      isTest: true,
      forceSend: !settings.dryRun,
      timestamp: Date.now()
    });
    return res;
  }

  // ---------------------------------------------------------------------------
  // In-Page Settings UI (Trusted-Types Safe DOM Construction)
  // ---------------------------------------------------------------------------

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
        right: 12px;
        bottom: 62px;
        z-index: 99999;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 999px;
        border: 1px solid #3f3f46;
        background: rgba(15, 15, 18, 0.9);
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
        font-weight: 600;
      }
      .yras-textarea,
      .yras-input {
        width: 100%;
        box-sizing: border-box;
        background: #24242c;
        color: #f1f1f4;
        border: 1px solid #2f2f3a;
        border-radius: 6px;
        padding: 6px 8px;
        font-family: inherit;
        font-size: 12px;
        outline: none;
      }
      .yras-textarea:focus,
      .yras-input:focus {
        border-color: #ff0033;
      }
      .yras-hint {
        margin-top: 5px;
        font-size: 11px;
        color: #9ca3af;
      }
      .yras-preview {
        margin-top: 6px;
        padding: 5px 7px;
        background: #0f0f12;
        border: 1px dashed #2f2f3a;
        border-radius: 6px;
        font-size: 11px;
        color: #d1d5db;
        word-break: break-all;
      }
      .yras-grid-2 {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .yras-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .yras-checkbox-row {
        display: flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        font-size: 11px;
      }
      .yras-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .yras-btn {
        border: none;
        border-radius: 6px;
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .yras-btn-primary {
        background: #ff0033;
        color: #fff;
      }
      .yras-btn-primary:hover {
        background: #d9002b;
      }
      .yras-btn-secondary {
        background: #24242c;
        color: #f1f1f4;
        border: 1px solid #2f2f3a;
      }
      .yras-btn-secondary:hover {
        background: #2e2e38;
      }
      .yras-btn-link {
        background: none;
        border: none;
        color: #9ca3af;
        font-size: 11px;
        cursor: pointer;
        text-decoration: underline;
      }
      .yras-toast {
        min-height: 16px;
        font-size: 11px;
        text-align: center;
        color: #22c55e;
      }
      .yras-toast.error {
        color: #ef4444;
      }
      .yras-history-list {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 140px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .yras-history-item {
        background: #24242c;
        border-radius: 6px;
        padding: 6px 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .yras-history-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .yras-history-channel {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .yras-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 4px;
      }
      .yras-badge-posted { background: rgba(34,197,94,0.15); color: #22c55e; }
      .yras-badge-dry-run { background: rgba(245,158,11,0.15); color: #f59e0b; }
      .yras-badge-failed { background: rgba(239,68,68,0.15); color: #ef4444; }
      .yras-history-url {
        font-size: 11px;
        color: #60a5fa;
        text-decoration: none;
        word-break: break-all;
      }
      .yras-history-time {
        font-size: 10px;
        color: #9ca3af;
      }
      .yras-history-error {
        font-size: 10px;
        color: #ef4444;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function buildModal() {
    if (modalRefs) return modalRefs;
    injectStyles();

    const launcher = el('button', '');
    launcher.id = 'yras-launcher';
    launcher.type = 'button';
    launcher.title = 'YouTube Raid Auto Shoutout 設定';
    const launcherDot = el('span');
    launcherDot.id = 'yras-launcher-dot';
    launcher.appendChild(launcherDot);
    launcher.appendChild(el('span', '', 'Raid設定'));

    const overlay = el('div');
    overlay.id = 'yras-overlay';

    const modal = el('div');
    modal.id = 'yras-modal';

    // Header
    const header = el('div', 'yras-header');
    const titleGroup = el('div', 'yras-title-group');
    titleGroup.appendChild(el('span', 'yras-badge-live', 'LIVE'));
    titleGroup.appendChild(el('span', 'yras-title', 'Raid Auto Shoutout'));

    const headerActions = el('div', 'yras-header-actions');
    const enabledLabel = el('label', 'yras-checkbox-row');
    const enabledToggle = document.createElement('input');
    enabledToggle.type = 'checkbox';
    enabledLabel.appendChild(enabledToggle);
    enabledLabel.appendChild(el('span', '', 'ON'));

    const closeBtn = el('button', 'yras-close', '×');
    closeBtn.type = 'button';
    headerActions.appendChild(enabledLabel);
    headerActions.appendChild(closeBtn);
    header.appendChild(titleGroup);
    header.appendChild(headerActions);

    // Body
    const body = el('div', 'yras-body');

    // Template Card
    const tplCard = el('div', 'yras-card');
    const tplHeader = el('div', 'yras-field-header');
    tplHeader.appendChild(el('span', 'yras-label', '投稿メッセージテンプレート'));
    const charCount = el('span', 'yras-char-count', '0 / 200');
    tplHeader.appendChild(charCount);

    const templateInput = el('textarea', 'yras-textarea');
    templateInput.rows = 3;
    templateInput.maxLength = 200;

    const hint = el('div', 'yras-hint', '変数: {channel}（チャンネル名）, {url}（@ハンドルURL）');
    const previewText = el('div', 'yras-preview');

    tplCard.appendChild(tplHeader);
    tplCard.appendChild(templateInput);
    tplCard.appendChild(hint);
    tplCard.appendChild(previewText);

    // Timing Card
    const timingCard = el('div', 'yras-card yras-grid-2');
    const delayField = el('div', 'yras-field');
    delayField.appendChild(el('span', 'yras-label', '投稿遅延（秒）'));
    const delayInput = el('input', 'yras-input');
    delayInput.type = 'number';
    delayInput.min = '0';
    delayInput.max = '60';
    delayField.appendChild(delayInput);

    const cooldownField = el('div', 'yras-field');
    cooldownField.appendChild(el('span', 'yras-label', '重複防止（秒）'));
    const cooldownInput = el('input', 'yras-input');
    cooldownInput.type = 'number';
    cooldownInput.min = '5';
    cooldownInput.max = '600';
    cooldownField.appendChild(cooldownInput);

    timingCard.appendChild(delayField);
    timingCard.appendChild(cooldownField);

    // DryRun Card
    const dryRunCard = el('div', 'yras-card');
    const dryRunLabel = el('label', 'yras-checkbox-row');
    const dryRunCheckbox = document.createElement('input');
    dryRunCheckbox.type = 'checkbox';
    dryRunLabel.appendChild(dryRunCheckbox);
    dryRunLabel.appendChild(el('span', '', 'テストモード（送信せず履歴のみ記録）'));
    dryRunCard.appendChild(dryRunLabel);

    // Actions
    const actions = el('div', 'yras-actions');
    const saveBtn = el('button', 'yras-btn yras-btn-primary', '設定を保存');
    saveBtn.type = 'button';
    const testBtn = el('button', 'yras-btn yras-btn-secondary', 'テスト投稿');
    testBtn.type = 'button';
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);

    const statusToast = el('div', 'yras-toast');

    // History Card
    const historyCard = el('div', 'yras-card');
    const historyHeader = el('div', 'yras-field-header');
    historyHeader.appendChild(el('span', 'yras-label', '検知・投稿履歴'));
    const clearHistoryBtn = el('button', 'yras-btn-link', 'クリア');
    clearHistoryBtn.type = 'button';
    historyHeader.appendChild(clearHistoryBtn);

    const historyList = el('ul', 'yras-history-list');
    historyCard.appendChild(historyHeader);
    historyCard.appendChild(historyList);

    body.appendChild(tplCard);
    body.appendChild(timingCard);
    body.appendChild(dryRunCard);
    body.appendChild(actions);
    body.appendChild(statusToast);
    body.appendChild(historyCard);

    modal.appendChild(header);
    modal.appendChild(body);
    overlay.appendChild(modal);

    document.body.appendChild(launcher);
    document.body.appendChild(overlay);

    modalRefs = {
      launcher,
      launcherDot,
      overlay,
      enabledToggle,
      templateInput,
      charCount,
      previewText,
      delayInput,
      cooldownInput,
      dryRunCheckbox,
      saveBtn,
      testBtn,
      clearHistoryBtn,
      historyList,
      statusToast
    };

    launcher.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    templateInput.addEventListener('input', updatePreview);
    enabledToggle.addEventListener('change', () => saveFromModal(false));
    saveBtn.addEventListener('click', () => saveFromModal(false));
    clearHistoryBtn.addEventListener('click', () => {
      clearHistory();
      showToast('履歴をクリアしました');
    });
    testBtn.addEventListener('click', async () => {
      saveFromModal(true);
      testBtn.disabled = true;
      const res = await runTestShoutout();
      testBtn.disabled = false;
      if (res?.ok) {
        showToast(res.dryRun ? 'テストモードで履歴に記録しました' : 'テストメッセージを送信しました');
      } else {
        showToast(res?.error || 'テスト投稿に失敗しました', true);
      }
    });

    syncLauncherIndicator();
    return modalRefs;
  }

  function showToast(message, isError = false) {
    if (!modalRefs) return;
    clearTimeout(toastTimer);
    modalRefs.statusToast.textContent = message;
    modalRefs.statusToast.classList.toggle('error', isError);
    toastTimer = setTimeout(() => {
      if (modalRefs) modalRefs.statusToast.textContent = '';
    }, 3000);
  }

  function updatePreview() {
    if (!modalRefs) return;
    const raw = modalRefs.templateInput.value || DEFAULT_SETTINGS.template;
    const preview = formatShoutoutMessage(raw, SAMPLE_CHANNEL, SAMPLE_URL);
    modalRefs.previewText.textContent = `プレビュー: ${preview}`;
    modalRefs.charCount.textContent = `${preview.length} / ${MAX_CHAT_LENGTH}`;
    modalRefs.charCount.classList.toggle('over', preview.length > MAX_CHAT_LENGTH);
  }

  function syncLauncherIndicator() {
    if (!modalRefs) return;
    const { enabled } = getSettings();
    modalRefs.launcherDot.classList.toggle('off', !enabled);
  }

  function renderHistory(history) {
    if (!modalRefs) return;
    const listEl = modalRefs.historyList;
    listEl.textContent = '';

    if (!Array.isArray(history) || history.length === 0) {
      listEl.appendChild(el('li', 'yras-history-time', 'まだレイドの検知履歴はありません。'));
      return;
    }

    const statusMap = {
      posted: { label: '投稿済み', cls: 'yras-badge-posted' },
      'dry-run': { label: 'テスト記録', cls: 'yras-badge-dry-run' },
      failed: { label: '失敗', cls: 'yras-badge-failed' }
    };

    for (const item of history) {
      const li = el('li', 'yras-history-item');
      const top = el('div', 'yras-history-top');
      top.appendChild(el('span', 'yras-history-channel', item.channelName || 'チャンネル'));

      const st = statusMap[item.status] || { label: item.status || '不明', cls: 'yras-badge-dry-run' };
      top.appendChild(el('span', `yras-badge ${st.cls}`, st.label));
      li.appendChild(top);

      if (item.channelUrl) {
        const link = el('a', 'yras-history-url', item.channelUrl);
        link.href = item.channelUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        li.appendChild(link);
      }

      if (item.error) {
        li.appendChild(el('div', 'yras-history-error', item.error));
      }

      if (item.timestamp) {
        const tsStr = new Date(item.timestamp).toLocaleString('ja-JP', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        li.appendChild(el('div', 'yras-history-time', tsStr));
      }

      listEl.appendChild(li);
    }
  }

  function saveFromModal(silent = false) {
    if (!modalRefs) return;
    const next = {
      enabled: modalRefs.enabledToggle.checked,
      template: modalRefs.templateInput.value.trim() || DEFAULT_SETTINGS.template,
      delaySeconds: Math.min(60, Math.max(0, Number(modalRefs.delayInput.value) || 0)),
      cooldownSeconds: Math.min(600, Math.max(5, Number(modalRefs.cooldownInput.value) || 30)),
      dryRun: modalRefs.dryRunCheckbox.checked
    };
    saveSettings(next);
    syncLauncherIndicator();
    if (!silent) {
      showToast('設定を保存しました');
    }
  }

  function openModal() {
    const refs = buildModal();
    const settings = getSettings();
    refs.enabledToggle.checked = settings.enabled;
    refs.templateInput.value = settings.template;
    refs.delayInput.value = String(settings.delaySeconds);
    refs.cooldownInput.value = String(settings.cooldownSeconds);
    refs.dryRunCheckbox.checked = settings.dryRun;
    updatePreview();
    renderHistory(getHistory());
    refs.overlay.classList.add('open');
  }

  function closeModal() {
    if (modalRefs) {
      modalRefs.overlay.classList.remove('open');
    }
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  hookNetworkAndInitialData();
  setupDomObserver();
  if (document.body) {
    buildModal();
  } else {
    window.addEventListener('DOMContentLoaded', buildModal, { once: true });
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('⚙️ Raid Auto Shoutout 設定', openModal);
    GM_registerMenuCommand('🧪 テスト投稿を実行', async () => {
      const res = await runTestShoutout();
      openModal();
      showToast(
        res?.ok
          ? res.dryRun
            ? 'テストモードで履歴に記録しました'
            : 'テストメッセージを送信しました'
          : res?.error || 'テスト投稿に失敗しました',
        !res?.ok
      );
    });
  }
})();
