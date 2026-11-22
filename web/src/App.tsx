import { useEffect } from 'react';
import { startEvents } from './lib/events';
import { useStore } from './store';
import { ChatView } from './components/ChatView';
import { ComputerViewer } from './components/ComputerViewer';
import { DetailsPanel } from './components/DetailsPanel';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { CreateBotModal } from './components/modals/CreateBotModal';
import { CreateGroupModal } from './components/modals/CreateGroupModal';
import { SearchModal } from './components/modals/SearchModal';
import { ConfigLayer } from './components/config/ConfigLayer';
import { TasksView } from './components/config/TasksView';
import { useConfigUI } from './configStore';

function Shell() {
  const detailsOpen = useStore((s) => s.detailsOpen);
  const phone = useStore((s) => s.phone);
  const mobileOpen = useStore((s) => s.mobileOpen);
  const phoneDetails = useStore((s) => s.phoneDetails);
  const modal = useStore((s) => s.modal);
  const viewerOpen = useStore((s) => s.viewerOpen);
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const botId = useStore((s) => s.selectedBotId);
  const view = useConfigUI((s) => s.view);

  useEffect(() => {
    const st = useStore.getState();
    st.loadBots().catch(console.error);
    st.loadComputer().catch(console.error);
    return startEvents();
  }, []);

  // Phone layout follows the screen width.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = () => useStore.setState({ phone: mq.matches });
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // Global shortcuts: ⌘K search, ⌘B sidebar, ⇧⌘, details, ⌘N new bot.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const st = useStore.getState();
      const key = e.key.toLowerCase();
      if (key === 'k') { e.preventDefault(); st.setModal(st.modal === 'search' ? null : 'search'); }
      else if (key === 'b') { e.preventDefault(); st.set({ sidebarCollapsed: !st.sidebarCollapsed }); }
      else if (e.shiftKey && (key === ',' || key === '<')) { e.preventDefault(); st.showDetails(!(st.phone ? st.phoneDetails : st.detailsOpen)); }
      else if (key === ',') { e.preventDefault(); useConfigUI.getState().openAppSettings(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const showComputer = !!botId && view === 'chat' && viewerOpen;
  const showDetails = !!botId && view === 'chat' && (phone ? phoneDetails : detailsOpen) && !showComputer;

  return (
    <div className={`app${collapsed ? ' is-sidebar-collapsed' : ''}${showDetails ? ' has-details' : ''}${phone ? ' is-phone' : ''}${mobileOpen ? ' is-mobile-open' : ''}`}>
      <Sidebar />
      {view === 'tasks' ? <TasksView /> : <ChatView />}
      {showDetails && <DetailsPanel />}
      {modal === 'create' && <CreateBotModal />}
      {modal === 'group' && <CreateGroupModal />}
      {modal === 'search' && <SearchModal />}
      {showComputer && <ComputerViewer key={botId} />}
      <ConfigLayer />
    </div>
  );
}

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  useEffect(() => { useStore.getState().checkAuth(); }, []);
  if (!authChecked) return <div className="boot" />;
  return user ? <Shell /> : <SignIn />;
}
