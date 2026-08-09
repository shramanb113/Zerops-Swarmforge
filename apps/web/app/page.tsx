'use client';

import { useEffect, useRef, useState } from 'react';

const CONTROL_PLANE_URL = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? 'http://localhost:3000';
const POLL_MS = 2000;
const ROLES = ['architect', 'coder', 'deployer', 'observer', 'healer', 'tester'] as const;

interface PresenceAgent {
  role: string;
  instanceId: string;
}

interface Task {
  id: string;
  role: string;
  type: string;
  status: string;
  payload: unknown;
  createdAt: string;
}

interface TaskEvent {
  id: string;
  taskId: string;
  role: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}

interface Product {
  id: string;
  name: string;
  status: string;
}

interface Proposal {
  id: string;
  productId: string;
  taskId: string | null;
}

interface WorldState {
  tasks: Task[];
  events: TaskEvent[];
  products: Product[];
  proposals: Proposal[];
}

interface CodeFile {
  path: string;
  content: string;
}

interface FileTreeNode {
  type: 'dir';
  name: string;
  children: Map<string, FileTreeNode | FileTreeLeaf>;
}

interface FileTreeLeaf {
  type: 'file';
  name: string;
  path: string;
}

function buildFileTree(files: CodeFile[]): FileTreeNode {
  const root: FileTreeNode = { type: 'dir', name: '', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let cursor = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        cursor.children.set(part, { type: 'file', name: part, path: f.path });
        return;
      }
      const existing = cursor.children.get(part);
      if (existing && existing.type === 'dir') {
        cursor = existing;
      } else {
        const dir: FileTreeNode = { type: 'dir', name: part, children: new Map() };
        cursor.children.set(part, dir);
        cursor = dir;
      }
    });
  }
  return root;
}

function FileTree({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: FileTreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="file-tree">
      {[...node.children.values()].map((child) =>
        child.type === 'dir' ? (
          <li key={child.name}>
            <div className="tree-dir" style={{ paddingLeft: 12 + depth * 16 }}>
              {child.name}/
            </div>
            <FileTree node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
          </li>
        ) : (
          <li key={child.path}>
            <button
              className={`tree-file${selected === child.path ? ' active' : ''}`}
              style={{ paddingLeft: 12 + depth * 16 }}
              onClick={() => onSelect(child.path)}
            >
              {child.name}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

type StageStatus = 'idle' | 'pending' | 'in_progress' | 'done' | 'failed' | 'deployed';

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, init);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// Mirrors scripts/smoke.ts's lineage tracing: an architect task's own proposal -> product ->
// downstream coder/deployer tasks matched by productId, never a global "newest row" lookup -
// this project already learned that lesson once (a false-green smoke test matched stale rows).
function traceLineage(state: WorldState, architectTaskId: string) {
  const proposal = state.proposals.find((p) => p.taskId === architectTaskId);
  if (!proposal) return null;
  const productId = proposal.productId;
  const downstream = state.tasks.filter((t) => (t.payload as { productId?: string } | null)?.productId === productId);
  const coderTask = downstream.find((t) => t.role === 'coder');
  const deployerTask = downstream.find((t) => t.role === 'deployer');
  const product = state.products.find((p) => p.id === productId);
  return { proposal, product, coderTask, deployerTask };
}

export default function Page() {
  const [presence, setPresence] = useState<PresenceAgent[]>([]);
  const [state, setState] = useState<WorldState | null>(null);
  const [description, setDescription] = useState('');
  const [runStatus, setRunStatus] = useState('');
  const [starting, setStarting] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const trackedArchitectTaskId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const [presenceRes, stateRes] = await Promise.all([
          fetchJson<{ agents: PresenceAgent[] }>('/presence'),
          fetchJson<WorldState>('/world-state'),
        ]);
        if (cancelled) return;
        setPresence(presenceRes.agents);
        setState(stateRes);

        if (!trackedArchitectTaskId.current) {
          // Only adopt a task nobody on this page started if it's actually in flight - never a
          // finished one. Auto-adopting the newest DB row regardless of status would surface
          // stale leftover data (an old dev/test run) as if it were happening live right now.
          const inFlight = stateRes.tasks
            .filter((t) => t.role === 'architect' && t.type === 'build-product' && (t.status === 'pending' || t.status === 'in_progress'))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
          if (inFlight) trackedArchitectTaskId.current = inFlight.id;
        }
      } catch (err) {
        console.error('poll failed', err);
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const architectTask = state?.tasks.find((t) => t.id === trackedArchitectTaskId.current) ?? null;
  const lineage = state && trackedArchitectTaskId.current ? traceLineage(state, trackedArchitectTaskId.current) : null;

  const codeEvent = state?.events.find(
    (e) => e.eventType === 'code_generated' && e.taskId === lineage?.coderTask?.id,
  );
  const files = ((codeEvent?.payload as { files?: CodeFile[] } | undefined)?.files ?? []);
  const frontendFile = files.find((f) => f.path.toLowerCase().endsWith('.html')) ?? null;
  const deployEvent = state?.events.find(
    (e) => e.eventType === 'deploy_recorded' && e.taskId === lineage?.deployerTask?.id,
  );

  const openFile = files.find((f) => f.path === previewFile) ?? null;

  // Escape closes the preview, same as clicking the backdrop or the close button.
  useEffect(() => {
    if (!openFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewFile(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openFile]);

  async function runDemoBuild() {
    const trimmed = description.trim();
    if (!trimmed) {
      setRunStatus('Describe the product you want built first.');
      return;
    }
    setStarting(true);
    setRunStatus('Starting build…');
    try {
      const res = await fetchJson<{ id: string }>('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'build-product', role: 'architect', payload: { description: trimmed } }),
      });
      trackedArchitectTaskId.current = res.id;
      setPreviewFile(null);
      setRunStatus('Build started — tracking live below.');
    } catch (err) {
      setRunStatus(`Failed to start build: ${(err as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  const architectStatus: StageStatus = (architectTask?.status as StageStatus) ?? 'idle';
  const coderStatus: StageStatus = (lineage?.coderTask?.status as StageStatus) ?? 'idle';
  const deployerStatus: StageStatus = (lineage?.deployerTask?.status as StageStatus) ?? 'idle';
  const isDone = (s: StageStatus) => s === 'done' || s === 'deployed';
  const stagesDone = [architectStatus, coderStatus, deployerStatus].filter(isDone).length;
  const stageClass = (s: StageStatus) => (s === 'failed' ? '' : isDone(s) ? 'complete' : s === 'pending' || s === 'in_progress' ? 'active' : '');

  // "In flight" covers the whole pipeline, not just the architect stage - checking only the
  // architect task's own status let the button re-enable the moment Architect finished, while
  // Coder/Deployer were still working on that same run, letting a second click stack a
  // concurrent build on top of the first.
  const productTerminal = lineage?.product ? ['deployed', 'failed'].includes(lineage.product.status) : false;
  const inFlight = Boolean(architectTask) && architectStatus !== 'failed' && !productTerminal;

  return (
    <>
      <header>
        <div className="brand">
          <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
            <path d="M15 2 L26.5 8.5 V21.5 L15 28 L3.5 21.5 V8.5 Z" stroke="#f59e0b" strokeWidth="1.5" />
            <path d="M15 9 L20.5 12 V18 L15 21 L9.5 18 V12 Z" fill="#22c55e" opacity="0.85" />
          </svg>
          <h1>SwarmForge</h1>
        </div>
        <p>
          A multi-agent factory running on Zerops: describe any product in one sentence and watch
          three specialized agents — Architect, Coder, Deployer — design it, write real code for
          it, and deploy it, coordinating over NATS and Postgres in real time.
        </p>
      </header>
      <main>
        <section className="panel">
          <h2>Agents online</h2>
          <div className="presence-row">
            {ROLES.filter((role) => presence.some((a) => a.role === role)).map((role) => (
              <span className="presence-chip" key={role}>
                <span className="dot on" />
                {role}
              </span>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Build something</h2>
          <div className="run-form">
            <input
              type="text"
              maxLength={200}
              placeholder="Describe anything: a REST API for tracking books, a URL shortener, a todo list backend…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={inFlight || starting}
            />
            <button onClick={runDemoBuild} disabled={inFlight || starting}>
              {inFlight ? 'Build running…' : 'Build it'}
            </button>
          </div>
          <div className="run-status">
            {inFlight && !runStatus.startsWith('Build started') ? 'A build is already running — showing that run live.' : runStatus}
          </div>
        </section>

        <section className="panel">
          <h2>Pipeline</h2>
          <div className="rail-wrap">
            <div className="rail">
              <div className="rail-fill" style={{ width: `${(stagesDone / 3) * 100}%` }} />
            </div>
            <div className="stages">
              <div className={`stage ${stageClass(architectStatus)}`}>
                <div className="stage-name">
                  Architect <span className={`pill ${architectStatus}`}>{architectStatus}</span>
                </div>
                <div className="stage-detail">
                  {!architectTask
                    ? 'No run yet.'
                    : architectStatus === 'failed'
                      ? 'Architect task failed — see live events below.'
                      : lineage?.product
                        ? `Proposed "${lineage.product.name}"`
                        : 'Designing service architecture…'}
                </div>
              </div>
              <div className={`stage ${stageClass(coderStatus)}`}>
                <div className="stage-name">
                  Coder <span className={`pill ${coderStatus}`}>{coderStatus}</span>
                </div>
                <div className="stage-detail">
                  {!lineage?.coderTask
                    ? '—'
                    : coderStatus === 'failed'
                      ? 'Coder task failed — see live events below.'
                      : files.length > 0
                        ? `Wrote ${files.length} file${files.length === 1 ? '' : 's'} — see below.`
                        : 'Writing and compile-checking generated code…'}
                </div>
              </div>
              <div className={`stage ${stageClass(deployerStatus)}`}>
                <div className="stage-name">
                  Deployer <span className={`pill ${deployerStatus}`}>{deployerStatus}</span>
                </div>
                <div className="stage-detail">
                  {!lineage?.deployerTask
                    ? '—'
                    : deployEvent
                      ? `Deploy recorded (dryRun: ${String((deployEvent.payload as { dryRun?: boolean }).dryRun)}).`
                      : 'Deploying to Zerops…'}
                </div>
              </div>
            </div>
          </div>
        </section>

        {files.length > 0 && (
          <section className="panel">
            <h2>Generated code</h2>
            <FileTree node={buildFileTree(files)} depth={0} selected={previewFile} onSelect={setPreviewFile} />
          </section>
        )}

        {frontendFile && (
          <section className="panel">
            <h2>Live preview</h2>
            <iframe
              className="live-preview"
              srcDoc={frontendFile.content}
              sandbox="allow-scripts"
              title={`Live preview of ${frontendFile.path}`}
            />
          </section>
        )}

        <section className="panel">
          <h2>Live events</h2>
          <div className="events">
            {!state || state.events.length === 0 ? (
              <span className="empty">no events yet</span>
            ) : (
              state.events.slice(0, 20).map((e) => (
                <div className="event-row" key={e.id}>
                  <b>{e.eventType}</b> · {e.role} · {new Date(e.createdAt).toLocaleTimeString()}
                </div>
              ))
            )}
          </div>
        </section>
      </main>

      {openFile && (
        <div className="modal-backdrop" onClick={() => setPreviewFile(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>{openFile.path}</span>
              <button className="modal-close" aria-label="Close preview" onClick={() => setPreviewFile(null)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M1.5 1.5L12.5 12.5M12.5 1.5L1.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <pre className="code-pane modal-code">
              <code dangerouslySetInnerHTML={{ __html: highlight(openFile.content) }} />
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

/** Minimal, dependency-free TS/JS syntax highlighting - just enough to read as "real code", not a
 * full tokenizer. Escapes HTML first so the raw source can never inject markup, then a single
 * regex pass with a replacer function wraps whichever alternative matched. */
function highlight(code: string): string {
  const escaped = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const TOKEN =
    /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|\b(import|export|from|const|let|var|function|async|await|return|if|else|for|while|new|class|extends|interface|type|implements|try|catch|throw|typeof|as|default)\b|\b(\d+)\b/g;

  return escaped.replace(TOKEN, (match, comment, str, kw, num) => {
    if (comment) return `<span class="tok-com">${comment}</span>`;
    if (str) return `<span class="tok-str">${str}</span>`;
    if (kw) return `<span class="tok-kw">${kw}</span>`;
    if (num) return `<span class="tok-num">${num}</span>`;
    return match;
  });
}
