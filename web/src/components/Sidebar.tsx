import { memo, useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfigUI } from '../configStore';
import { TasksIsland } from './config/TasksView';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { displayName, isArchived, useStore } from '../store';
import { api } from '../lib/api';
import { Icon } from './Icon';
import { Menu } from './Menu';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function TrafficLights() {
  return (
    <div className="traffic-lights" aria-hidden>
      <span style={{ background: '#FF5F57' }} />
      <span style={{ background: '#FEBC2E' }} />
      <span style={{ background: '#28C840' }} />
    </div>
  );
}

function previewFor(bot: Bot, running: boolean, awaiting: string | null) {
  if (awaiting) return `Waiting for you: ${awaiting}`;
  if (running && !bot.lastPreview) return 'Working…';
  return bot.lastPreview ?? 'No messages yet';
}

const BotRow = memo(function BotRow({ bot, avatar, selected, running, awaiting, onSelect }: { bot: Bot; avatar: Bot; selected: boolean; running: boolean; awaiting: string | null; onSelect: (id: string) => void }) {
  return (
    <button type="button" className={`bot-row${selected ? ' is-selected' : ''}`} onClick={() => onSelect(bot.id)} aria-current={selected || undefined}>
      <span className="bot-row__avatar">
        <span aria-hidden><BotAvatarFor bot={avatar} size={36} /></span>
        {(running || awaiting || bot.unread > 0) && (
          <span className={`status-dot ${awaiting ? 'is-attention' : running ? 'is-working' : 'is-unread'}`} aria-label={awaiting ? 'Needs attention' : running ? 'Working' : 'Unread activity'} />
        )}
      </span>
      <span className="bot-row__text">
        <span className="bot-row__name">{displayName(bot)}</span>
        <span className="bot-row__preview">{previewFor(bot, running, awaiting)}</span>
      </span>
    </button>
  );
});

export function Sidebar() {
  const bots = useStore((s) => s.bots);
  const pendingArchive = useStore((s) => s.pendingArchive);
  const archiveError = useStore((s) => s.archiveError);
  const live = useStore((s) => s.live);
  const storeSelectedBotId = useStore((s) => s.selectedBotId);
  const inTasks = useConfigUI((s) => s.view === 'tasks');
  const selectedBotId = inTasks ? null : storeSelectedBotId; // nothing highlighted while the Tasks view is open
  const user = useStore((s) => s.user);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const set = useStore((s) => s.set);
  const storeSelectBot = useStore((s) => s.selectBot);
  // Picking a bot (even the one already selected) leaves the Tasks view.
  const selectBot = useCallback((id: string) => { useConfigUI.getState().setView('chat'); storeSelectBot(id); }, [storeSelectBot]);
  const setModal = useStore((s) => s.setModal);
  const [accountMenu, setAccountMenu] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const logout = async () => { await api.logout().catch(() => {}); location.reload(); };

  const { byId, children, roots } = useMemo(() => {
    const active = bots.filter((bot) => !isArchived(bot, pendingArchive));
    const byId = new Map(bots.map((bot) => [bot.id, bot]));
    const activeIds = new Set(active.map((bot) => bot.id));
    const children = new Map<string, Bot[]>();
    const roots: Bot[] = [];
    active.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    for (const bot of active) {
      if (bot.parentBotId && activeIds.has(bot.parentBotId)) {
        const siblings = children.get(bot.parentBotId) ?? [];
        siblings.push(bot);
        children.set(bot.parentBotId, siblings);
      } else roots.push(bot);
    }
    return { byId, children, roots };
  }, [bots, pendingArchive]);

  function renderBot(bot: Bot, nested = false) {
    const linked = children.get(bot.id);
    const open = expanded.has(bot.id);
    const primary = !nested && bot.isPrimary;
    const selected = selectedBotId === bot.id;
    const avatar = (nested && byId.get(bot.parentBotId ?? '')) || bot;
    const running = !!live[bot.id]?.isRunning;
    return (
      <div key={bot.id} className={primary ? 'bot-group bot-group--primary' : 'bot-group'}>
        <div className={primary ? 'pinned' : 'bot-group__row'}>
          {primary ? (
            <button type="button" className={`pinned__tile${selected ? ' is-selected' : ''}`} onClick={() => selectBot(bot.id)} title={displayName(bot)} aria-current={selected || undefined}>
              <span className="pinned__avatar">
                <BotAvatarFor bot={avatar} size={collapsed ? 44 : 60} star />
                {running && <span className="status-dot is-working pinned__dot" />}
              </span>
              {!collapsed && <span className="pinned__label">{displayName(bot)}</span>}
            </button>
          ) : collapsed ? (
            <button type="button" className={`bot-rail-item${selected ? ' is-selected' : ''}`} onClick={() => selectBot(bot.id)} title={displayName(bot)} aria-current={selected || undefined}>
              <span aria-hidden><BotAvatarFor bot={avatar} size={36} /></span>
            </button>
          ) : (
            <BotRow bot={bot} avatar={avatar} selected={selected} running={running} awaiting={live[bot.id]?.awaiting?.reason ?? null} onSelect={selectBot} />
          )}
          {linked && (
            <button type="button" className="bot-group__toggle" aria-expanded={open} aria-controls={`linked-${bot.id}`}
              aria-label={`Linked Bots for ${bot.name}`} onClick={() => setExpanded((previous) => {
                const next = new Set(previous);
                if (next.has(bot.id)) next.delete(bot.id);
                else next.add(bot.id);
                return next;
              })}>
              {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
          )}
        </div>
        {linked && (
          <div id={`linked-${bot.id}`} className="bot-group__children" hidden={!open}>
            {open && linked.map((child) => renderBot(child, true))}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar__titlebar">
        <TrafficLights />
        <div className="sidebar__controls">
          <button type="button" className="icon-btn icon-btn--plain" onClick={() => set({ sidebarCollapsed: !collapsed })} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title="Toggle sidebar (⌘B)">
            <Icon name="sidebar" opacity={0.66} />
          </button>
          {!collapsed && (
            <>
              <button type="button" className="icon-btn" onClick={() => setModal('search')} aria-label="Search" title="Search (⌘K)">
                <Icon name="search" opacity={0.66} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setModal('create')} aria-label="New Bot" title="New Bot">
                <Icon name="plus" opacity={0.66} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="sidebar__scroll">
        <TasksIsland />
        {archiveError && <div className="cfg-error" role="alert">{archiveError}</div>}
        <div className="bot-list">
          {roots.map((bot) => renderBot(bot))}
          {!collapsed && !roots.some((bot) => !bot.isPrimary || children.has(bot.id)) && (
            <button type="button" className="bot-list__empty" onClick={() => setModal('create')}>
              <span className="bot-list__empty-plus"><Icon name="plus" size={14} opacity={0.66} /></span>
              <span>
                <span className="bot-row__name">Create a Bot</span>
                <span className="bot-row__preview">Give it a job, like research or inbox triage</span>
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="sidebar__footer">
        <div className="sidebar__fade" />
        {!collapsed && (
          <div className="account">
            <button type="button" className="account__btn" onClick={() => setAccountMenu(!accountMenu)} aria-haspopup="menu" aria-expanded={accountMenu} title={user?.email}>
              <span className="account__initials">{initials(user?.name ?? user?.email ?? '')}</span>
              <span className="account__name">{user?.name ?? user?.email}</span>
            </button>
            {accountMenu && (
              <Menu
                placement="above"
                onClose={() => setAccountMenu(false)}
                items={[
                  { label: 'Settings', hint: '⌘,', onSelect: () => useConfigUI.getState().openAppSettings() },
                  { label: 'Log out', danger: true, onSelect: logout },
                ]}
              >
                <div className="menu__header">{user?.email}</div>
              </Menu>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
