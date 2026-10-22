/**
 * Client half of `dsh-billing`: a fourth pill in the composer's ambient dock row
 * (`conversation.composer.dock`), beside the shipped session-statistics and
 * token-usage pills and the context meter.
 *
 * This file is one browser module loaded by the harness module loader, so it is
 * plain JavaScript with no imports: everything it needs — the price baseline,
 * the pricing arithmetic and the view — lives here.
 *
 * Accuracy model (see `summarize`):
 *   - The whole-log `tokenUsage` session projection is the authoritative token
 *     total; the chat timeline only ever covers the loaded window.
 *   - When every loaded turn carries exactly one attributed route and the loaded
 *     turns add up to the projection, the total is exact.
 *   - Otherwise the total is priced from the whole-log buckets at the session's
 *     most recent route and the pill shows `≈`.
 *   - A model outside the price table is never given an invented number.
 */
window.__ModuleLoader__.load({
  id: 'dsh-billing-capsule',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let ReactDOM = null;
    try {
      ReactDOM = require('react-dom');
    } catch {
      ReactDOM = null;
    }
    const createPortal = ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
      ? ReactDOM.createPortal
      : null;

    /** Locale namespace used by `ctx.locale.register` and the slot registration. */
    const NS = 'billing';
    /** Official prices are quoted per one million tokens. */
    const UNIT = 1000000;
    /** Poll interval for the Host half's refreshed table. */
    const PRICE_POLL_MS = 6 * 3600 * 1000;

    /**
     * Bundled baseline, taken from the official pricing page on 2026-10-11 and
     * used whenever the Host half's table is unavailable. Keep it in sync with
     * `tests/fixture-pricing.html`; `tests/fetch-fixture.cjs` refreshes both.
     */
    const BASELINE = {
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      date: '2026-10-11',
      models: {
        'deepseek-flash': {
          cacheHitInput: { peak: 0.04, idle: 0.02 },
          cacheMissInput: { peak: 2, idle: 1 },
          output: { peak: 8, idle: 4 },
        },
        'deepseek-v4-pro': {
          cacheHitInput: { peak: 0.3, idle: 0.15 },
          cacheMissInput: { peak: 9, idle: 4.5 },
          output: { peak: 27, idle: 13.5 },
        },
      },
    };

    /**
     * Model names the official page still accepts under a different listed id.
     * Anything not listed here and not in the price table reads as "price
     * unknown" rather than being priced by guesswork.
     */
    const ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };

    /** Peak windows in Asia/Shanghai; every other instant is idle (half price). */
    const PEAK_WINDOWS = [
      { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
      { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
    ];

    const WEEKDAY_TO_ISO = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

    const SHANGHAI = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });

    // --------------------------------------------------------------------- //
    // Pricing: pure functions, mirrored by tests/client.test.js.             //
    // --------------------------------------------------------------------- //

    /** Calendar/clock facts of one instant in Asia/Shanghai. */
    function shanghaiParts(ms) {
      const parts = SHANGHAI.formatToParts(new Date(ms));
      const get = (type) => {
        const found = parts.find((part) => part.type === type);
        return found === undefined ? '' : found.value;
      };
      const hour = Number(get('hour')) % 24;
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        minutes: hour * 60 + Number(get('minute')),
        weekday: get('weekday').slice(0, 3),
      };
    }

    /**
     * Peak or idle for one instant.
     * @param ms - epoch milliseconds of the model request.
     * @param holidays - `YYYY-MM-DD` strings treated as idle.
     * @returns `'peak'` or `'idle'`.
     */
    function classifyWindow(ms, holidays) {
      const local = shanghaiParts(ms);
      if (Array.isArray(holidays) && holidays.includes(local.date)) return 'idle';
      const iso = WEEKDAY_TO_ISO[local.weekday];
      for (const window of PEAK_WINDOWS) {
        if (!window.days.includes(iso)) continue;
        const start = window.start.split(':').map(Number);
        const end = window.end.split(':').map(Number);
        if (local.minutes >= start[0] * 60 + start[1] && local.minutes < end[0] * 60 + end[1]) return 'peak';
      }
      return 'idle';
    }

    /** The four token buckets, accepting both the turn fold and request shapes. */
    function usageBuckets(usage) {
      const source = usage === null || usage === undefined ? {} : usage;
      return {
        uncachedInputTokens: Number(source.uncachedInputTokens ?? source.inputTokens ?? 0) || 0,
        cacheReadTokens: Number(source.cacheReadTokens ?? 0) || 0,
        cacheWriteTokens: Number(source.cacheWriteTokens ?? 0) || 0,
        outputTokens: Number(source.outputTokens ?? 0) || 0,
      };
    }

    function zeroBuckets() {
      return { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    }

    function addBuckets(target, add) {
      target.uncachedInputTokens += add.uncachedInputTokens;
      target.cacheReadTokens += add.cacheReadTokens;
      target.cacheWriteTokens += add.cacheWriteTokens;
      target.outputTokens += add.outputTokens;
      return target;
    }

    function sameBuckets(left, right) {
      return left.uncachedInputTokens === right.uncachedInputTokens
        && left.cacheReadTokens === right.cacheReadTokens
        && left.cacheWriteTokens === right.cacheWriteTokens
        && left.outputTokens === right.outputTokens;
    }

    function totalTokens(buckets) {
      return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
    }

    /** Token counts the official table prices; cache writes are not billed today. */
    function priceBuckets(buckets, entry, kind) {
      if (entry === null || entry === undefined) return null;
      const rate = (bucket) => (bucket === undefined ? 0 : Number(bucket[kind]) || 0);
      const cost = (
        buckets.uncachedInputTokens * rate(entry.cacheMissInput)
        + buckets.cacheReadTokens * rate(entry.cacheHitInput)
        + buckets.outputTokens * rate(entry.output)
      ) / UNIT;
      return Number.isFinite(cost) ? cost : null;
    }

    function validPrices(entry) {
      if (entry === null || typeof entry !== 'object') return false;
      return ['cacheHitInput', 'cacheMissInput', 'output'].every((bucket) => {
        const value = entry[bucket];
        if (value === null || typeof value !== 'object') return false;
        return ['peak', 'idle'].every((kind) => {
          const price = value[kind];
          return typeof price === 'number' && Number.isFinite(price) && price > 0 && price <= 10000;
        });
      });
    }

    /** Keep only complete, sane model entries so a bad payload cannot misprice. */
    function sanitizeModels(source) {
      const out = {};
      if (source === null || typeof source !== 'object') return out;
      for (const id of Object.keys(source)) {
        if (id !== '' && validPrices(source[id])) out[id] = source[id];
      }
      return out;
    }

    /** Validate the Host half's payload; null means "keep what we already have". */
    function validatePricesPayload(payload) {
      if (payload === null || typeof payload !== 'object' || payload.ok !== true) return null;
      const models = sanitizeModels(payload.models);
      const overrides = sanitizeModels(payload.overrides);
      if (Object.keys(models).length === 0 && Object.keys(overrides).length === 0) return null;
      return {
        source: typeof payload.source === 'string' ? payload.source : null,
        fetchedAt: typeof payload.fetchedAt === 'string' ? payload.fetchedAt : null,
        models,
        overrides,
        note: typeof payload.note === 'string' ? payload.note : null,
      };
    }

    /** Baseline < fetched < patch overrides. */
    function mergeModels(baseline, fetched, overrides) {
      return { ...baseline, ...fetched, ...overrides };
    }

    function lookupModel(models, modelId) {
      if (typeof modelId !== 'string' || modelId === '') return null;
      const aliased = ALIASES[modelId] ?? modelId;
      if (Object.prototype.hasOwnProperty.call(models, aliased)) return aliased;
      const lower = aliased.toLowerCase();
      for (const key of Object.keys(models)) {
        if (key.toLowerCase() === lower) return key;
      }
      return null;
    }

    /**
     * Read the loaded turns' token accounting out of the chat snapshot.
     *
     * This is the single adapter over `ui-chat`'s node shape: the whole-log
     * `tokenUsage` projection stays authoritative for the session total, and
     * this only supplies the per-turn breakdown. Any shape it cannot read
     * yields null, and the caller degrades instead of guessing.
     */
    function readTurns(timeline) {
      const turns = timeline === null || timeline === undefined ? undefined : timeline.turns;
      if (turns === undefined || turns === null || typeof turns.values !== 'function') return null;
      const rows = [];
      for (const turn of turns.values()) {
        if (turn === null || typeof turn !== 'object') continue;
        const data = turn.data;
        if (data === undefined || data === null || typeof data.get !== 'function') continue;
        const tail = data.get('turn-tail');
        const usage = tail === null || tail === undefined ? undefined : tail.tokenUsage;
        if (usage === undefined || usage === null) continue;
        const startTime = turn.start === undefined || turn.start === null ? undefined : turn.start.time;
        const endTime = turn.end === undefined || turn.end === null ? undefined : turn.end.time;
        rows.push({
          turn: typeof turn.turn === 'number' ? turn.turn : 0,
          at: typeof startTime === 'number' ? startTime : typeof endTime === 'number' ? endTime : null,
          usage,
          routes: Array.isArray(usage.routes) ? usage.routes : null,
        });
      }
      return rows.length === 0 ? null : rows;
    }

    /** The session's most recent route, from the durable model-selection projection. */
    function selectedRoute(selection) {
      if (selection === null || selection === undefined) return null;
      const route = selection.lastUsed ?? selection.next;
      if (route === null || route === undefined || typeof route.model !== 'string') return null;
      return { provider: String(route.provider ?? ''), model: route.model };
    }

    function routeLabel(route) {
      if (route === null) return null;
      return route.provider === '' ? route.model : `${route.provider}/${route.model}`;
    }

    /** Format money; `digits` controls precision and `¥` is the unit. */
    function money(value, digits) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '--';
      const floor = Math.pow(10, -digits);
      if (value > 0 && value < floor) return `<¥${floor.toFixed(digits)}`;
      return `¥${value.toFixed(digits)}`;
    }

    function formatTokens(value) {
      const n = Number(value) || 0;
      try {
        return n.toLocaleString();
      } catch {
        return String(n);
      }
    }

    /**
     * Fold the session's usage into the numbers the pill and dialog show.
     * @returns a summary object; `hasUsage === false` means render nothing.
     */
    function summarize(input) {
      const models = mergeModels(BASELINE.models, input.fetched === null ? {} : input.fetched.models, input.fetched === null ? {} : input.fetched.overrides);
      const holidays = Array.isArray(input.holidays) ? input.holidays : [];
      const now = input.nowMs;
      const route = selectedRoute(input.selection);
      const turns = readTurns(input.timeline);

      const projection = input.usage === undefined || input.usage === null ? null : usageBuckets(input.usage);
      const hasProjection = projection !== null && totalTokens(projection) > 0;

      let turnsSum = zeroBuckets();
      let turnsPriced = 0;
      let turnsUnknown = 0;
      let everyTurnExact = turns !== null && turns.length > 0;
      const pricedKeys = new Set();
      const rows = [];

      if (turns !== null) {
        for (const turn of turns) {
          const kind = classifyWindow(turn.at === null ? now : turn.at, holidays);
          const buckets = usageBuckets(turn.usage);
          addBuckets(turnsSum, buckets);
          const exactRoute = turn.routes !== null && turn.routes.length === 1 ? turn.routes[0] : null;
          const effective = exactRoute ?? route;
          const key = effective === null ? null : lookupModel(models, effective.model);
          const cost = key === null ? null : priceBuckets(buckets, models[key], kind);
          if (key === null) {
            turnsUnknown += 1;
            everyTurnExact = false;
          } else {
            turnsPriced += cost;
            pricedKeys.add(key);
            if (exactRoute === null) everyTurnExact = false;
          }
          rows.push({
            turn: turn.turn,
            buckets,
            kind,
            route: routeLabel(effective),
            cost,
          });
        }
      }

      const covered = hasProjection && turns !== null && sameBuckets(turnsSum, projection);
      const buckets = hasProjection ? projection : turnsSum;
      const total = totalTokens(buckets);
      if (total === 0) {
        return { hasUsage: false, rows: [], buckets, total: 0 };
      }

      let amount = null;
      let exact = false;
      let scope = 'none';
      let rateKey = null;
      let rateKind = null;
      const kinds = new Set(rows.map((row) => row.kind));
      if (covered && everyTurnExact) {
        amount = turnsPriced;
        exact = true;
        scope = 'turns';
        if (pricedKeys.size === 1 && kinds.size === 1) {
          rateKey = Array.from(pricedKeys)[0];
          rateKind = Array.from(kinds)[0];
        }
      } else if (hasProjection) {
        const kind = classifyWindow(now, holidays);
        const key = route === null ? null : lookupModel(models, route.model);
        amount = key === null ? null : priceBuckets(projection, models[key], kind);
        scope = 'session';
        rateKey = key;
        rateKind = key === null ? null : kind;
      } else if (turns !== null) {
        amount = turnsUnknown > 0 ? null : turnsPriced;
        scope = 'turns-partial';
        if (pricedKeys.size === 1 && kinds.size === 1) {
          rateKey = Array.from(pricedKeys)[0];
          rateKind = Array.from(kinds)[0];
        }
      }

      return {
        hasUsage: true,
        buckets,
        total,
        amount,
        exact,
        scopeLabel: scope === 'turns' ? 'turns' : scope === 'session' ? 'session' : 'turns-partial',
        rows,
        models,
        turnsUnknown,
        turnsLoaded: turns === null ? 0 : turns.length,
        turnsPriced,
        kinds,
        rateModel: rateKey,
        rateEntry: rateKey === null ? null : models[rateKey] ?? null,
        rateKind,
        route: routeLabel(route),
        routeMissing: route === null,
        fetched: input.fetched,
      };
    }

    // --------------------------------------------------------------------- //
    // Locale dictionaries.                                                   //
    // --------------------------------------------------------------------- //

    const zh = {
      'pill.label': '账单',
      'pill.aria': '会话账单：{total}',
      'pill.ariaUnknown': '会话账单：{tokens} tokens，单价未知',
      'dialog.title': '会话账单',
      'dialog.approx': '≈',
      'dialog.scope.turns': '整会话逐轮精确计价',
      'dialog.scope.session': '按整会话总量与当前模型估算',
      'dialog.scope.turnsPartial': '仅统计已加载轮次（整会话投影不可用）',
      'dialog.bucket.uncachedInput': '未缓存输入',
      'dialog.bucket.cacheRead': '缓存读取',
      'dialog.bucket.cacheWrite': '缓存写入',
      'dialog.bucket.output': '输出',
      'dialog.bucket.total': '合计',
      'dialog.window.peak': '高峰',
      'dialog.window.idle': '空闲',
      'dialog.tokensCount': '{count} tokens',
      'dialog.model': '计价模型：{model}',
      'dialog.modelUnknown': '单价未知',
      'dialog.modelNone': '尚未发起模型请求',
      'dialog.turns': '逐轮明细',
      'dialog.turnsPartialHint': '以下为已加载轮次，合计与上方总额可能不一致。',
      'dialog.turnRow': '第 {turn} 轮',
      'dialog.unit': '单价单位：元 / 百万 tokens',
      'dialog.source.auto': '单价来源：官方页面自动刷新（{time}）',
      'dialog.source.baseline': '单价来源：内置基线（{date}）',
      'dialog.source.baselineStale': '单价来源：内置基线（{date}） · 自动刷新失败：{reason}',
      'dialog.holidayNote': '高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00；其余时段及周末按空闲（半价）。未内置中国法定节假日。',
      'dialog.cacheWriteNote': '官方价目表未列缓存写入单价，该桶按 0 计价。',
      'dialog.unknownNote': '有 {count} 轮使用了价目表之外的模型，未计入金额。',
      'dialog.mixedNote': '这些轮次使用了不同模型，已按各轮实际路由分别计价。',
      'dialog.close': '关闭',
    };

    const en = {
      'pill.label': 'Cost',
      'pill.aria': 'Session cost: {total}',
      'pill.ariaUnknown': 'Session cost: {tokens} tokens, price unknown',
      'dialog.title': 'Session cost',
      'dialog.approx': '≈',
      'dialog.scope.turns': 'Exact, priced per loaded turn',
      'dialog.scope.session': 'Estimated from the whole-session total and the current model',
      'dialog.scope.turnsPartial': 'Loaded turns only (no whole-session projection)',
      'dialog.bucket.uncachedInput': 'Uncached input',
      'dialog.bucket.cacheRead': 'Cached input',
      'dialog.bucket.cacheWrite': 'Cache write',
      'dialog.bucket.output': 'Output',
      'dialog.bucket.total': 'Total',
      'dialog.window.peak': 'peak',
      'dialog.window.idle': 'idle',
      'dialog.tokensCount': '{count} tokens',
      'dialog.model': 'Priced with: {model}',
      'dialog.modelUnknown': 'price unknown',
      'dialog.modelNone': 'no model request yet',
      'dialog.turns': 'Per-turn detail',
      'dialog.turnsPartialHint': 'Loaded turns only; they may not add up to the total above.',
      'dialog.turnRow': 'Turn {turn}',
      'dialog.unit': 'Unit: currency per 1,000,000 tokens',
      'dialog.source.auto': 'Prices: refreshed from the official page ({time})',
      'dialog.source.baseline': 'Prices: bundled baseline ({date})',
      'dialog.source.baselineStale': 'Prices: bundled baseline ({date}) · refresh failed: {reason}',
      'dialog.holidayNote': 'Peak hours are Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time; everything else is idle (half price). Chinese public holidays are not built in.',
      'dialog.cacheWriteNote': 'The official table lists no cache-write price, so that bucket counts as 0.',
      'dialog.unknownNote': '{count} turns used a model outside the price table and are excluded from the amount.',
      'dialog.mixedNote': 'These turns used different models and were priced with each turn’s own route.',
      'dialog.close': 'Close',
    };

    // --------------------------------------------------------------------- //
    // Styles: theme tokens only, so light and dark both read correctly.       //
    // --------------------------------------------------------------------- //

    const CSS = `
.dshb_root{display:inline-flex;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}
.dshb_pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer;}
.dshb_pill svg{flex:none;width:14px;height:14px;}
.dshb_pill:hover,.dshb_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);}
.dshb_pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.dshb_label{min-width:0;overflow:hidden;text-overflow:ellipsis;}
.dshb_approx{color:var(--dsw-alias-state-warn-primary);}
.dshb_panel{position:fixed;z-index:70;box-sizing:border-box;max-height:min(62vh,460px);overflow-y:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 8px 32px rgba(0,0,0,.18);font-size:12px;line-height:18px;}
.dshb_head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;}
.dshb_title{font-size:13px;font-weight:500;}
.dshb_total{font-variant-numeric:tabular-nums;}
.dshb_scope{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;}
.dshb_dl{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;margin:8px 0 0;}
.dshb_dl dt{color:var(--dsw-alias-label-secondary);}
.dshb_dl dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;}
.dshb_dl dd.dshb_rate{color:var(--dsw-alias-label-secondary);}
.dshb_rule{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0;}
.dshb_note{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;margin:6px 0 0;}
.dshb_note p{margin:0 0 2px;word-break:break-word;}
.dshb_sectionTitle{margin:10px 0 4px;color:var(--dsw-alias-label-secondary);font-size:11px;}
.dshb_turns{list-style:none;margin:0;padding:0;max-height:200px;overflow-y:auto;}
.dshb_turn{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:1px 0;font-variant-numeric:tabular-nums;}
.dshb_turnMeta{min-width:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
`;

    // --------------------------------------------------------------------- //
    // View.                                                                  //
    // --------------------------------------------------------------------- //

    /** The Host half's refreshed table, or null while it is unavailable. */
    function usePriceTable() {
      const [fetched, setFetched] = React.useState(null);
      React.useEffect(() => {
        let active = true;
        const load = () => {
          fetch('/dsh-billing/prices.json', { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then((payload) => {
              const table = validatePricesPayload(payload);
              if (active && table !== null) setFetched(table);
            })
            .catch(() => {
              // No route, no network, or a foreign origin: the bundled baseline stands.
            });
        };
        load();
        const timer = setInterval(load, PRICE_POLL_MS);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, []);
      return fetched;
    }

    /** Open state, anchoring and dismissal for the details dialog. */
    function useBillingDialog() {
      const [open, setOpen] = React.useState(false);
      const [pos, setPos] = React.useState(null);
      const rootRef = React.useRef(null);
      const panelRef = React.useRef(null);

      React.useEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const anchor = rootRef.current;
          if (anchor === null) return;
          const rect = anchor.getBoundingClientRect();
          const width = Math.min(340, Math.max(240, window.innerWidth - 24));
          const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12));
          setPos({ left, width, bottom: Math.max(12, window.innerHeight - rect.top + 8) });
        };
        place();
        const focusTrigger = () => {
          const button = rootRef.current === null ? null : rootRef.current.querySelector('button');
          if (button !== null) button.focus();
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          setOpen(false);
          focusTrigger();
        };
        const onPointerDown = (event) => {
          const panel = panelRef.current;
          const anchor = rootRef.current;
          if (panel !== null && panel.contains(event.target)) return;
          if (anchor !== null && anchor.contains(event.target)) return;
          setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);

      return { open, setOpen, rootRef, panelRef, pos };
    }

    function coinIcon() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false }, [
        h('circle', { key: 'c', cx: 8, cy: 8, r: 6.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', {
          key: 'p',
          d: 'M6.1 4.9h3.3M6.1 7.1h3.3M7.8 4.9v6.2M5.4 7.1h4.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function bucketRowKeys() {
      return ['uncachedInput', 'cacheRead', 'cacheWrite', 'output'];
    }

    /** One `dt/dd` pair triple: label, token count, subtotal. */
    function bucketNodes(summary, t) {
      const bucketOf = {
        uncachedInput: 'uncachedInputTokens',
        cacheRead: 'cacheReadTokens',
        cacheWrite: 'cacheWriteTokens',
        output: 'outputTokens',
      };
      const kind = summary.rateKind === undefined ? null : summary.rateKind;
      const kindWord = kind === null ? null : t(kind === 'peak' ? 'dialog.window.peak' : 'dialog.window.idle');
      const entry = summary.rateEntry;
      const nodes = [];
      for (const name of bucketRowKeys()) {
        const tokens = summary.buckets[bucketOf[name]];
        const rate = entry === null || entry === undefined
          ? null
          : name === 'uncachedInput'
            ? entry.cacheMissInput
            : name === 'cacheRead'
              ? entry.cacheHitInput
              : name === 'output'
                ? entry.output
                : null;
        const price = rate === null || kind === null ? null : Number(rate[kind]);
        nodes.push(h('dt', { key: `${name}.dt` }, t(`dialog.bucket.${name}`)));
        nodes.push(h('dd', { key: `${name}.dd` }, [
          h('span', { key: 'tok' }, formatTokens(tokens)),
          price === null || !Number.isFinite(price)
            ? null
            : h('span', { key: 'rate', className: 'dshb_rate' }, ` · ${price}${kindWord === null ? '' : ` ${kindWord}`}`),
        ]));
        const subtotal = rate === null || kind === null || price === null || !Number.isFinite(price)
          ? null
          : (tokens * price) / UNIT;
        nodes.push(h('dd', { key: `${name}.sub` }, subtotal === null ? '--' : money(subtotal, 4)));
      }
      return nodes;
    }

    function BillingDialog(props) {
      const { t, summary, dialog, fetched } = props;
      const style = dialog.pos === null
        ? { left: 12, width: 340, bottom: 12 }
        : dialog.pos;
      const children = [];

      children.push(h('div', { className: 'dshb_head', key: 'head' }, [
        h('span', { className: 'dshb_title', key: 'title' }, t('dialog.title')),
        h('span', {
          key: 'total',
          className: summary.exact ? 'dshb_total' : 'dshb_total dshb_approx',
        }, `${summary.exact ? '' : t('dialog.approx')}${money(summary.amount, 2)}`),
      ]));
      children.push(h('div', { className: 'dshb_scope', key: 'scope' }, [
        t(`dialog.scope.${summary.scopeLabel}`),
        ' · ',
        t('dialog.tokensCount', { count: formatTokens(summary.total) }),
      ]));

      children.push(h('dl', { className: 'dshb_dl', key: 'buckets' }, bucketNodes(summary, t)));

      const notes = [];
      notes.push(t('dialog.unit'));
      notes.push(t('dialog.model', {
        model: summary.rateModel === null || summary.rateModel === undefined
          ? t('dialog.modelUnknown')
          : summary.rateModel,
      }));
      if (fetched === null) {
        notes.push(t('dialog.source.baseline', { date: BASELINE.date }));
      } else {
        const when = fetched.fetchedAt === null ? fetched.source ?? '' : fetched.fetchedAt;
        notes.push(t('dialog.source.auto', { time: when }));
        if (fetched.note !== null) notes.push(fetched.note);
      }
      notes.push(t('dialog.holidayNote'));
      notes.push(t('dialog.cacheWriteNote'));
      if (summary.turnsUnknown > 0) notes.push(t('dialog.unknownNote', { count: summary.turnsUnknown }));
      if (summary.scopeLabel === 'turns' && summary.kinds.size > 1) notes.push(t('dialog.mixedNote'));
      if (summary.routeMissing && summary.scopeLabel !== 'turns') notes.push(t('dialog.modelNone'));

      children.push(h('hr', { className: 'dshb_rule', key: 'rule' }));
      children.push(h('div', { className: 'dshb_note', key: 'notes' }, notes.map((note) => h('p', { key: note }, note))));

      if (summary.rows.length > 0) {
        const turns = summary.rows.slice().sort((left, right) => right.turn - left.turn);
        children.push(h('div', { className: 'dshb_sectionTitle', key: 'turnsTitle' }, t('dialog.turns')));
        if (summary.scopeLabel === 'session') {
          children.push(h('div', { className: 'dshb_note', key: 'turnsHint' }, t('dialog.turnsPartialHint')));
        }
        children.push(h('ul', { className: 'dshb_turns', key: 'turns' }, turns.map((row) => h('li', {
          key: `turn-${row.turn}`,
          className: 'dshb_turn',
        }, [
          h('span', { key: 'l', className: 'dshb_turnMeta' }, t('dialog.turnRow', { turn: row.turn })),
          h('span', { key: 'm', className: 'dshb_turnMeta' }, [
            formatTokens(totalTokens(row.buckets)),
            ' tok · ',
            row.route === null ? t('dialog.modelUnknown') : row.route,
            ' · ',
            t(row.kind === 'peak' ? 'dialog.window.peak' : 'dialog.window.idle'),
          ]),
          h('span', { key: 'v', className: row.cost === null ? 'dshb_approx' : '' }, row.cost === null ? '--' : money(row.cost, 4)),
        ]))));
      }

      return h('div', {
        ref: dialog.panelRef,
        className: 'dshb_panel',
        role: 'dialog',
        'aria-label': t('dialog.title'),
        style,
      }, children);
    }

    const pillAmount = (summary) => (summary.amount === null ? '--' : `${summary.exact ? '' : '≈'}${money(summary.amount, 2)}`);

    const BillingPill = React.memo(function BillingPill(props) {
      const { t, useProjection, useChat } = props;
      const usage = useProjection('tokenUsage');
      const selection = useProjection('modelSelection');
      const timeline = useChat((snapshot) => (snapshot === null || snapshot === undefined ? null : snapshot.timeline));
      const fetched = usePriceTable();
      const dialog = useBillingDialog();

      const summary = React.useMemo(() => summarize({
        usage,
        selection,
        timeline,
        fetched,
        holidays: [],
        nowMs: Date.now(),
      }), [usage, selection, timeline, fetched]);

      if (!summary.hasUsage) return null;

      const amount = pillAmount(summary);
      const label = amount === '--' ? t('pill.label') : `${amount} · ${t('pill.label')}`;
      const aria = summary.amount === null
        ? t('pill.ariaUnknown', { tokens: formatTokens(summary.total) })
        : t('pill.aria', { total: amount });

      const panel = dialog.open
        ? h(BillingDialog, { t, summary, dialog, fetched, key: 'panel' })
        : null;
      const placed = panel === null
        ? null
        : createPortal !== null && typeof document !== 'undefined'
          ? createPortal(panel, document.body)
          : panel;

      return h('span', { className: 'dshb_root', ref: dialog.rootRef }, [
        h('button', {
          key: 'pill',
          type: 'button',
          className: 'dshb_pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': dialog.open,
          'aria-label': aria,
          title: aria,
          onClick: () => dialog.setOpen(!dialog.open),
        }, [
          coinIcon(),
          h('span', {
            key: 'label',
            className: summary.amount !== null && summary.exact ? 'dshb_label' : 'dshb_label dshb_approx',
          }, label),
        ]),
        placed,
      ]);
    });

    // --------------------------------------------------------------------- //
    // Plugin body.                                                           //
    // --------------------------------------------------------------------- //

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-billing: dictionaries');
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const marker = 'dsh-billing-capsule/client.css';
        const existing = document.querySelector(`style[data-plugin-css="${marker}"]`);
        if (existing !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-billing-capsule';
        tag.dataset.pluginCss = marker;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'dsh-billing: styles');
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'billing',
        order: 1,
        locale: NS,
      }, BillingPill));
    }

    return {
      inject: ['slots', 'locale'],
      apply,
      /** Pure surface for tests/client.test.js; not used by the running plugin. */
      __billing: {
        BASELINE,
        ALIASES,
        PEAK_WINDOWS,
        classifyWindow,
        usageBuckets,
        totalTokens,
        priceBuckets,
        validatePricesPayload,
        mergeModels,
        lookupModel,
        readTurns,
        selectedRoute,
        summarize,
        money,
      },
    };
  },
});
