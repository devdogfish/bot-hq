import { create } from 'zustand';
import type { Bot, ComputerState, LiveState, Routine, Row, ServerEvent, SoundSet, User } from '@shared/types';
import { playSound, replySound } from './lib/sounds';
import { noteLiveReaction, reactionKey } from './lib/liveReactions';
import { ApiError, api } from './lib/api';

export type ModalKind = 'create' | 'search' | 'group' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  devLogin: boolean;
  authChecked: boolean;

  bots: Bot[];
  pendingPause: Record<string, boolean | undefined>;
  pendingArchive: Record<string, boolean | undefined>;
  archiveError: string | null;
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Bumped on every `connections` event so open views can refetch. */
  sseConnected: boolean;

  detailsOpen: boolean;
  sidebarCollapsed: boolean;
  modal: ModalKind;
  viewerOpen: boolean;
  /** How the large computer view opens, and the mode it is in while open. */
  viewerMode: 'watch' | 'control';
  /** One line shown under the large computer view while the person is driving (e.g. a sign-in to finish). */
  viewerHint: string | null;

  checkAuth(): Promise<void>;
  loadBots(): Promise<void>;
  setBotPaused(id: string, paused: boolean): Promise<void>;
  setBotArchived(id: string, archived: boolean): Promise<void>;
  selectBot(id: string): void;
  loadRows(id: string): Promise<void>;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  upsertRows(botId: string, generation: number, rows: Row[], live?: boolean): void;
  setSoundSet(soundSet: SoundSet): Promise<void>;
  handleEvent(ev: ServerEvent): void;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

const LS_SELECTED = 'bothq.selectedBot';
const LS_DETAILS = 'bothq.detailsOpen';
const LS_SIDEBAR = 'bothq.sidebarCollapsed';
/** Settings saved before the project was renamed (`grokbot.<name>`) are still read. */
const lsGet = (k: string) => { try { return localStorage.getItem(k) ?? localStorage.getItem(k.replace(/^bothq\./, 'grokbot.')); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const isArchived = (bot: Bot, pending: State['pendingArchive']) => pending[bot.id] ?? (bot.archivedAt != null);

export const useStore = create<State>((set, get) => ({
  user: null,
  devLogin: false,
  authChecked: false,
  bots: [],
  pendingPause: {},
  pendingArchive: {},
  archiveError: null,
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  transcripts: {},
  routines: {},
  computer: null,
  sseConnected: false,
  detailsOpen: lsGet(LS_DETAILS) !== '0',
  sidebarCollapsed: lsGet(LS_SIDEBAR) === '1',
  modal: null,
  viewerOpen: false,
  viewerMode: 'watch',
  viewerHint: null,

  async checkAuth() {
    try {
      const { user, devLogin } = await api.me();
      set({ user, devLogin, authChecked: true });
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  async loadBots() {
    const { bots, live } = await api.bots();
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    set({ bots, live: liveMap });
    syncSelection(true);
  },

  async setBotPaused(id, paused) {
    if (get().pendingPause[id] !== undefined) return;
    set((s) => ({ pendingPause: { ...s.pendingPause, [id]: paused } }));
    try {
      const saved = await api.setPaused(id, paused);
      set((s) => ({ bots: s.bots.map((b) => b.id === id ? { ...b, paused: saved.paused } : b) }));
    } catch (error) {
      // A missing response may have arrived after the server saved the change.
      if (!(error instanceof ApiError) || error.status >= 500) {
        const refreshed = await get().loadBots().then(() => true, () => false);
        if (refreshed && get().bots.find((b) => b.id === id)?.paused === paused) return;
        if (!refreshed) throw new Error('Could not check the saved state. Reload before trying again.');
      }
      throw error;
    } finally {
      set((s) => {
        const pendingPause = { ...s.pendingPause };
        delete pendingPause[id];
        return { pendingPause };
      });
    }
  },

  async setBotArchived(id, archived) {
    const pending = get().pendingArchive;
    if (pending[id] === archived) return;
    set({ pendingArchive: { ...pending, [id]: archived }, archiveError: null });
    syncSelection();
    if (pending[id] !== undefined) return; // The in-flight save will send the latest intent next.
    try {
      let desired = get().pendingArchive[id];
      while (desired !== undefined) {
        const current = get().bots.find((b) => b.id === id);
        if (!current || (current.archivedAt != null) === desired) break;
        try {
          const { bot } = await api.setArchived(id, desired);
          set((s) => ({ bots: s.bots.map((b) => b.id === id ? { ...b, archivedAt: bot.archivedAt, draftOnlyAvailable: bot.draftOnlyAvailable } : b) }));
        } catch (error) {
          if (!(error instanceof ApiError) || error.status >= 500) {
            // The server may have saved the change before the response was lost.
            try {
              await get().loadBots();
              const saved = get().bots.find((b) => b.id === id);
              if (!saved || (saved.archivedAt != null) !== desired) throw error;
            } catch {
              set({ archiveError: `Couldn’t verify the change to ${current.name}. Reload to check its status.` });
              if (get().pendingArchive[id] === desired) break;
            }
          } else if (get().pendingArchive[id] === desired) {
            set({ archiveError: `Couldn’t ${desired ? 'archive' : 'unarchive'} ${current.name}. ${(error as Error).message}` });
            break;
          }
        }
        desired = get().pendingArchive[id];
      }
    } finally {
      set((s) => {
        const pendingArchive = { ...s.pendingArchive };
        delete pendingArchive[id];
        return { pendingArchive };
      });
      syncSelection();
    }
  },

  selectBot(id) {
    const bot = get().bots.find((b) => b.id === id);
    if (!bot || isArchived(bot, get().pendingArchive)) return;
    if (get().selectedBotId !== id) {
      set({ selectedBotId: id, viewerOpen: false, viewerMode: 'watch', viewerHint: null });
    }
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    if (bot.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const { generation, rows } = await api.rows(id);
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching.
    const prev = get().transcripts[id];
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const { computer } = await api.computer();
    set({ computer });
  },

  upsertRows(botId, generation, rows, live = false) {
    let receive = false;
    let reacted = false;
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        // A new reply from the Agent in the open chat gets the receive sound (live events only, not loads).
        if (!cur && live && botId === s.selectedBotId && r.body.type === 'message' && r.body.role === 'assistant') receive = true;
        // A tapback that just landed animates in, and sounds in the open chat.
        const reaction = r.body.type === 'message' ? r.body.reaction : undefined;
        const before = cur?.body.type === 'message' ? cur.body.reaction : undefined;
        if (live && reaction && reaction.at !== before?.at) {
          noteLiveReaction(reactionKey(botId, r.seq, reaction.at));
          if (botId === s.selectedBotId) reacted = true;
        }
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
    if (receive) {
      const role = replySound(botId, get().live[botId]?.startedAt);
      if (role) playSound(role);
    }
    if (reacted) playSound('reaction');
  },

  async setSoundSet(soundSet) {
    const before = get().user?.soundSet;
    set((st) => (st.user ? { user: { ...st.user, soundSet } } : {}));
    try { await api.setSoundSet(soundSet); } catch (e) {
      set((st) => (st.user && before ? { user: { ...st.user, soundSet: before } } : {}));
      throw e;
    }
  },

  handleEvent(ev) {
    const s = get();
    switch (ev.type) {
      case 'hello':
      case 'ping':
        return;
      case 'rows':
        s.upsertRows(ev.botId, ev.generation, ev.rows, true);
        return;
      case 'cleared':
        set((st) => ({ transcripts: { ...st.transcripts, [ev.botId]: { generation: ev.generation, bySeq: {}, loaded: true } } }));
        return;
      case 'live':
        set((st) => ({ live: { ...st.live, [ev.state.botId]: ev.state } }));
        return;
      case 'roster':
        s.loadBots().catch(console.error);
        return;
      case 'bot': {
        const exists = s.bots.some((b) => b.id === ev.bot.id);
        // Opening a bot marks it read; keep the open bot at 0 unread.
        if (ev.bot.id === s.selectedBotId && ev.bot.unread > 0 && document.visibilityState === 'visible') api.markRead(ev.bot.id).catch(() => {});
        set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === ev.bot.id ? ev.bot : b)) : [...st.bots, ev.bot] }));
        if (!s.selectedBotId || s.selectedBotId === ev.bot.id) syncSelection();
        return;
      }
      case 'computer':
        set({ computer: ev.state });
        return;
      case 'routines':
        if (s.routines[ev.botId] || ev.botId === s.selectedBotId) s.loadRoutines(ev.botId).catch(console.error);
        return;
      case 'tasks':
      case 'memories':
        // Picked up by configStore.ts (Tasks view, Library/Tasks tabs, bot settings).
        window.dispatchEvent(new CustomEvent('bothq:event', { detail: ev }));
        return;
    }
  },

  setModal(modal) { set({ modal }); },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    if (p.sidebarCollapsed !== undefined) lsSet(LS_SIDEBAR, p.sidebarCollapsed ? '1' : '0');
    set(p);
  },
}));

function syncSelection(loadMissing = false) {
  const s = useStore.getState();
  const active = s.bots.filter((bot) => !isArchived(bot, s.pendingArchive));
  if (active.some((bot) => bot.id === s.selectedBotId)) {
    if (loadMissing && s.selectedBotId && !s.transcripts[s.selectedBotId]) s.selectBot(s.selectedBotId);
    return;
  }
  const fallback = active.find((bot) => bot.isPrimary) ?? active[0];
  if (fallback) s.selectBot(fallback.id);
  else if (s.selectedBotId) {
    s.set({ selectedBotId: null, viewerOpen: false, viewerMode: 'watch', viewerHint: null });
    lsSet(LS_SELECTED, '');
  }
}

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}
