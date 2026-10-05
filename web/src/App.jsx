import clsx from 'clsx';
import { StoreProvider, useStore } from './store.jsx';
import Layout from './components/Layout.jsx';
import Overview from './pages/Overview.jsx';
import Playground from './pages/Playground.jsx';
import Providers from './pages/Providers.jsx';
import Routing from './pages/Routing.jsx';
import Logs from './pages/Logs.jsx';

const PAGES = { overview: Overview, playground: Playground, providers: Providers, routing: Routing, logs: Logs };

function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="fixed bottom-20 lg:bottom-6 right-4 z-50 space-y-2 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'px-4 py-2.5 rounded-xl border text-sm shadow-2xl backdrop-blur-xl animate-[tin_.2s_ease]',
            t.kind === 'err' ? 'bg-red-500/15 border-red-500/30 text-red-200'
              : t.kind === 'okk' ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-200'
              : 'bg-ink-700/90 border-white/10 text-mist-300'
          )}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

function PageSwitch() {
  const { tab } = useStore();
  const Page = PAGES[tab] || Overview;
  return (
    <div key={tab} className="animate-[fadein_.25s_ease]">
      <Page />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Layout>
        <PageSwitch />
      </Layout>
      <Toasts />
    </StoreProvider>
  );
}
