import { Component } from 'react';
import clsx from 'clsx';
import { AlertTriangle } from 'lucide-react';
import { StoreProvider, useStore } from './store.jsx';
import Layout from './components/Layout.jsx';
import Overview from './pages/Overview.jsx';
import Playground from './pages/Playground.jsx';
import Providers from './pages/Providers.jsx';
import Routing from './pages/Routing.jsx';
import Logs from './pages/Logs.jsx';
import Admin from './pages/Admin.jsx';
import Login from './pages/Login.jsx';

const PAGES = { overview: Overview, playground: Playground, providers: Providers, routing: Routing, logs: Logs, admin: Admin };

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-lg mt-16 p-6 rounded-2xl border border-red-500/25 bg-red-500/[0.08] text-center animate-[pop_.3s_ease]">
          <AlertTriangle className="mx-auto text-red-300" size={28} />
          <h2 className="text-white font-semibold mt-3">Halaman ini error</h2>
          <p className="text-xs text-red-200/70 mt-2 font-mono break-all">{String(this.state.error?.message || this.state.error)}</p>
          <button
            className="mt-4 px-4 py-2 rounded-lg bg-white/10 border border-white/15 text-sm text-white cursor-pointer hover:bg-white/15 transition-colors"
            onClick={() => this.setState({ error: null })}
          >
            Coba lagi
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="fixed bottom-20 lg:bottom-6 right-4 z-50 space-y-2 max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'px-4 py-2.5 rounded-xl border text-sm shadow-2xl backdrop-blur-xl animate-[slidein_.25s_ease]',
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
    <ErrorBoundary key={tab}>
      <div className="animate-[fadein_.25s_ease]">
        <Page />
      </div>
    </ErrorBoundary>
  );
}

function Root() {
  const { needsLogin, onLogin } = useStore();
  if (needsLogin) {
    return (
      <>
        <Login onLogin={onLogin} defaultPassword={!!(typeof window !== 'undefined' && window.__LOLLM__?.defaultPassword)} />
        <Toasts />
      </>
    );
  }
  return (
    <>
      <Layout>
        <PageSwitch />
      </Layout>
      <Toasts />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  );
}
